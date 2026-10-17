/**
 * One normalised order shape fed by both sources:
 *  - GraphQL Admin API order nodes (backfill / reconciliation)
 *  - REST-style webhook payloads (orders/create, orders/updated)
 * Keeping a single shape means the row mapping is identical whichever path wrote the row.
 */
export interface NormalizedLineItem {
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
}

export interface NormalizedOrder {
  /** Numeric order id as a string, e.g. "5123456789012". The upsert key. */
  id: string;
  name: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  cancelledAt: string | null;
  /** lower snake case, e.g. "paid", "partially_refunded" */
  financialStatus: string | null;
  /** lower snake case, e.g. "unfulfilled", "partially_fulfilled" */
  fulfillmentStatus: string | null;
  subtotal: string | null;
  discounts: string | null;
  shipping: string | null;
  tax: string | null;
  total: string | null;
  currency: string | null;
  lineItems: NormalizedLineItem[];
  tags: string[];
  sourceName: string | null;
  test: boolean;
  shippingCountry: string | null;
  shippingCity: string | null;
  customerName: string | null;
  customerEmail: string | null;
}

/** "gid://shopify/Order/123" -> "123"; "123" -> "123" */
export function orderIdFromGid(gidOrId: string | number): string {
  const s = String(gidOrId);
  const m = s.match(/(\d+)\s*$/);
  return m ? m[1] : s;
}

const snake = (v: unknown): string | null =>
  typeof v === "string" && v.trim()
    ? v.trim().toLowerCase().replace(/[\s-]+/g, "_")
    : null;

const money = (v: unknown): string | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object") {
    // MoneyBag { shopMoney: { amount } } or { shop_money: { amount } }
    const o = v as Record<string, any>;
    const m = o.shopMoney ?? o.shop_money;
    return m ? money(m.amount) : null;
  }
  const n = String(v);
  return /^-?\d+(\.\d+)?$/.test(n) ? n : null;
};

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length ? v : null;

const joinName = (first?: unknown, last?: unknown): string | null => {
  const s = [first, last].filter((x) => typeof x === "string" && x).join(" ");
  return s || null;
};

/* ------------------------------------------------------------------ */
/* GraphQL                                                             */
/* ------------------------------------------------------------------ */

export function fromGraphQL(node: any): NormalizedOrder {
  const lineItems: NormalizedLineItem[] = (
    node.lineItems?.nodes ??
    node.lineItems?.edges?.map((e: any) => e.node) ??
    []
  ).map((li: any) => ({
    title: li.title ?? li.name ?? "",
    variantTitle: str(li.variantTitle),
    sku: str(li.sku),
    quantity: Number(li.quantity ?? 0),
  }));

  return {
    id: orderIdFromGid(node.legacyResourceId ?? node.id),
    name: node.name,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt ?? node.createdAt,
    cancelledAt: node.cancelledAt ?? null,
    financialStatus: snake(node.displayFinancialStatus),
    fulfillmentStatus: snake(node.displayFulfillmentStatus),
    subtotal: money(node.subtotalPriceSet),
    discounts: money(node.totalDiscountsSet),
    shipping: money(node.totalShippingPriceSet),
    tax: money(node.totalTaxSet),
    total: money(node.totalPriceSet),
    currency: str(node.currencyCode),
    lineItems,
    tags: Array.isArray(node.tags) ? node.tags : [],
    sourceName: str(node.sourceName),
    test: Boolean(node.test),
    shippingCountry: str(node.shippingAddress?.country),
    shippingCity: str(node.shippingAddress?.city),
    customerName:
      str(node.customer?.displayName) ??
      joinName(node.customer?.firstName, node.customer?.lastName),
    customerEmail: str(node.email) ?? str(node.customer?.email),
  };
}

/* ------------------------------------------------------------------ */
/* Webhook (REST resource shape)                                       */
/* ------------------------------------------------------------------ */

const WEBHOOK_FULFILLMENT: Record<string, string> = {
  partial: "partially_fulfilled",
  fulfilled: "fulfilled",
  restocked: "restocked",
};

export function fromWebhook(p: any): NormalizedOrder {
  const shippingFromLines = Array.isArray(p.shipping_lines)
    ? p.shipping_lines
        .reduce((sum: number, l: any) => sum + Number(l.price ?? 0), 0)
        .toFixed(2)
    : null;

  return {
    id: orderIdFromGid(p.id ?? p.admin_graphql_api_id),
    name: p.name,
    createdAt: p.created_at,
    updatedAt: p.updated_at ?? p.created_at,
    cancelledAt: p.cancelled_at ?? null,
    financialStatus: snake(p.financial_status),
    // REST sends null for unfulfilled orders
    fulfillmentStatus: p.fulfillment_status
      ? (WEBHOOK_FULFILLMENT[p.fulfillment_status] ?? snake(p.fulfillment_status))
      : "unfulfilled",
    subtotal: money(p.subtotal_price_set ?? p.subtotal_price),
    discounts: money(p.total_discounts_set ?? p.total_discounts),
    shipping: money(p.total_shipping_price_set) ?? shippingFromLines,
    tax: money(p.total_tax_set ?? p.total_tax),
    total: money(p.total_price_set ?? p.total_price),
    currency: str(p.currency),
    lineItems: (p.line_items ?? []).map((li: any) => ({
      title: li.title ?? li.name ?? "",
      variantTitle: str(li.variant_title),
      sku: str(li.sku),
      quantity: Number(li.quantity ?? 0),
    })),
    tags:
      typeof p.tags === "string"
        ? p.tags.split(",").map((t: string) => t.trim()).filter(Boolean)
        : Array.isArray(p.tags)
          ? p.tags
          : [],
    sourceName: str(p.source_name),
    test: Boolean(p.test),
    shippingCountry: str(p.shipping_address?.country),
    shippingCity: str(p.shipping_address?.city),
    customerName: joinName(p.customer?.first_name, p.customer?.last_name),
    customerEmail: str(p.email) ?? str(p.contact_email) ?? str(p.customer?.email),
  };
}
