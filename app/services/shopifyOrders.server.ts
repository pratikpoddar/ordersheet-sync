import { unauthenticated } from "../shopify.server";
import { fromGraphQL, type NormalizedOrder } from "../lib/normalize";
import { HttpError, sleep, ThrottledError, withRetry } from "../lib/retry";

export type AdminGraphql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

const PAGE_SIZE = 40; // 40 orders x 20 line items keeps the query cost well under the 1000-point cap
const LINE_ITEMS_PER_ORDER = 20;

function orderFields(includeProtected: boolean) {
  return `
    id
    legacyResourceId
    name
    createdAt
    updatedAt
    cancelledAt
    test
    displayFinancialStatus
    displayFulfillmentStatus
    currencyCode
    subtotalPriceSet { shopMoney { amount } }
    totalDiscountsSet { shopMoney { amount } }
    totalShippingPriceSet { shopMoney { amount } }
    totalTaxSet { shopMoney { amount } }
    totalPriceSet { shopMoney { amount } }
    tags
    sourceName
    lineItems(first: ${LINE_ITEMS_PER_ORDER}) {
      nodes { title variantTitle sku quantity }
      pageInfo { hasNextPage endCursor }
    }
    ${
      includeProtected
        ? `email
    customer { displayName }
    shippingAddress { country city }`
        : ""
    }
  `;
}

export async function adminFor(shop: string): Promise<AdminGraphql> {
  const { admin } = await unauthenticated.admin(shop);
  return admin.graphql as unknown as AdminGraphql;
}

/** Translate Shopify client errors into retryable errors where appropriate. */
function classify(err: any): unknown {
  const text = JSON.stringify(err?.body ?? err?.response ?? err?.message ?? "");
  if (/THROTTLED|Throttled/.test(text)) return new ThrottledError(2000);
  const status = err?.response?.code ?? err?.response?.status ?? err?.status;
  if (typeof status === "number") return new HttpError(err?.message || `Shopify error ${status}`, status);
  return err;
}

/** Run one GraphQL call with retries and leaky-bucket awareness. */
export async function gql<T = any>(graphql: AdminGraphql, query: string, variables?: Record<string, unknown>): Promise<T> {
  const json: any = await withRetry(async () => {
    let res: Response;
    try {
      res = await graphql(query, { variables });
    } catch (err) {
      throw classify(err);
    }
    const body: any = await res.json();
    if (body.errors?.length) {
      const throttled = body.errors.some((e: any) => e?.extensions?.code === "THROTTLED");
      if (throttled) throw new ThrottledError(2000);
      throw new Error(body.errors.map((e: any) => e.message).join("; "));
    }
    return body;
  }, {
    retries: 6,
    baseMs: 1000,
    onRetry: (err, attempt, delay) => console.warn(`[shopify] retry ${attempt} in ${delay}ms: ${(err as Error).message}`),
  });

  // Proactively wait if the bucket is nearly empty, instead of hitting THROTTLED.
  const t = json.extensions?.cost?.throttleStatus;
  if (t && t.currentlyAvailable < 300 && t.restoreRate > 0) {
    await sleep(Math.ceil(((300 - t.currentlyAvailable) / t.restoreRate) * 1000));
  }
  return json.data as T;
}

async function fetchRemainingLineItems(graphql: AdminGraphql, orderGid: string, after: string) {
  const items: any[] = [];
  let cursor: string | null = after;
  while (cursor) {
    const data: any = await gql(graphql, `#graphql
      query RemainingLineItems($id: ID!, $after: String) {
        order(id: $id) {
          lineItems(first: 100, after: $after) {
            nodes { title variantTitle sku quantity }
            pageInfo { hasNextPage endCursor }
          }
        }
      }`, { id: orderGid, after: cursor });
    const conn = data.order?.lineItems;
    if (!conn) break;
    items.push(...conn.nodes);
    cursor = conn.pageInfo.hasNextPage ? conn.pageInfo.endCursor : null;
  }
  return items;
}

/**
 * One page of orders after `after` (null = first page), oldest first so a backfill fills
 * the sheet chronologically. The returned endCursor is persisted by the job runner so the
 * next serverless invocation continues exactly where this one stopped.
 */
export async function fetchOrdersPage(
  graphql: AdminGraphql,
  searchQuery: string,
  opts: { after: string | null; includeProtected: boolean; sortKey?: "CREATED_AT" | "UPDATED_AT" },
): Promise<{ items: NormalizedOrder[]; endCursor: string | null; hasNextPage: boolean }> {
  const query = `#graphql
    query Orders($first: Int!, $after: String, $query: String, $sortKey: OrderSortKeys) {
      orders(first: $first, after: $after, query: $query, sortKey: $sortKey) {
        nodes { ${orderFields(opts.includeProtected)} }
        pageInfo { hasNextPage endCursor }
      }
    }`;
  const data: any = await gql(graphql, query, {
    first: PAGE_SIZE,
    after: opts.after,
    query: searchQuery || null,
    sortKey: opts.sortKey ?? "CREATED_AT",
  });
  const conn = data.orders;
  for (const node of conn.nodes) {
    if (node.lineItems?.pageInfo?.hasNextPage) {
      node.lineItems.nodes.push(...(await fetchRemainingLineItems(graphql, node.id, node.lineItems.pageInfo.endCursor)));
    }
  }
  return {
    items: conn.nodes.map(fromGraphQL),
    endCursor: conn.pageInfo.endCursor ?? null,
    hasNextPage: Boolean(conn.pageInfo.hasNextPage),
  };
}

/** Async generator over all orders matching `searchQuery`, page by page (kept for scripts/tools). */
export async function* iterateOrders(
  graphql: AdminGraphql,
  searchQuery: string,
  opts: { includeProtected: boolean; sortKey?: "CREATED_AT" | "UPDATED_AT" },
): AsyncGenerator<NormalizedOrder[]> {
  let after: string | null = null;
  do {
    const page = await fetchOrdersPage(graphql, searchQuery, { ...opts, after });
    yield page.items;
    after = page.hasNextPage ? page.endCursor : null;
  } while (after);
}

export async function fetchShopTimezone(graphql: AdminGraphql): Promise<string> {
  const data: any = await gql(graphql, `#graphql
    query ShopTz { shop { ianaTimezone } }`);
  return data.shop?.ianaTimezone || "UTC";
}

export async function fetchOrderById(graphql: AdminGraphql, orderId: string, includeProtected: boolean) {
  const data: any = await gql(graphql, `#graphql
    query OneOrder($id: ID!) { order(id: $id) { ${orderFields(includeProtected)} } }`, { id: `gid://shopify/Order/${orderId}` });
  if (!data.order) return null;
  const node = data.order;
  if (node.lineItems?.pageInfo?.hasNextPage) {
    node.lineItems.nodes.push(...(await fetchRemainingLineItems(graphql, node.id, node.lineItems.pageInfo.endCursor)));
  }
  return fromGraphQL(node);
}

/** Reads active subscriptions straight from Shopify (used outside a request, e.g. by cron). */
export async function fetchActivePlanNames(graphql: AdminGraphql): Promise<string[]> {
  const data: any = await gql(graphql, `#graphql
    query Plan { currentAppInstallation { activeSubscriptions { name status } } }`);
  return (data.currentAppInstallation?.activeSubscriptions ?? [])
    .filter((s: any) => s.status === "ACTIVE")
    .map((s: any) => s.name);
}
