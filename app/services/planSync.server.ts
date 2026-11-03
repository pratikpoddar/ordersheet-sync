import { tierFromSubscriptions, type PlanTier, type SubscriptionLike } from "../lib/plans";
import { authenticate } from "../shopify.server";
import { ensureShop, getPlan, setPlan } from "./shopData.server";

type GraphQL = (q: string, o?: { variables?: Record<string, unknown> }) => Promise<Response>;

export interface ActiveSubscription extends SubscriptionLike {
  id: string;
  test: boolean;
  trialDays: number | null;
  currentPeriodEnd: string | null;
}

const ACTIVE_SUBSCRIPTIONS = `#graphql
  query ActiveSubscriptions {
    currentAppInstallation {
      activeSubscriptions {
        id name status test trialDays currentPeriodEnd
        lineItems { plan { pricingDetails { ... on AppRecurringPricing { price { amount currencyCode } } } } }
      }
    }
  }`;

/**
 * Reads the shop's subscriptions straight from Shopify (managed pricing creates them, so we never
 * filter by our own plan name or by test/real: review and development stores get test charges).
 */
export async function fetchActiveSubscriptions(graphql: GraphQL): Promise<ActiveSubscription[]> {
  const res = await graphql(ACTIVE_SUBSCRIPTIONS);
  const json = (await res.json()) as {
    data?: { currentAppInstallation?: { activeSubscriptions?: ActiveSubscription[] } };
    errors?: unknown;
  };
  if (json.errors) throw new Error(`activeSubscriptions query failed: ${JSON.stringify(json.errors)}`);
  return json.data?.currentAppInstallation?.activeSubscriptions ?? [];
}

/** Refresh the cached plan from Shopify; on a transient API failure keep the cached plan. */
export async function syncPlan(shop: string, graphql: GraphQL): Promise<{ plan: PlanTier; subscriptions: ActiveSubscription[] }> {
  try {
    const subscriptions = await fetchActiveSubscriptions(graphql);
    const plan = await setPlan(shop, tierFromSubscriptions(subscriptions));
    return { plan, subscriptions };
  } catch (err) {
    if (err instanceof Response) throw err; // re-auth handled by the library
    console.error(`[plan] could not read subscriptions for ${shop}`, err);
    return { plan: await getPlan(shop), subscriptions: [] };
  }
}

/**
 * Authenticate an embedded admin request and refresh the cached plan. Every loader/action uses
 * this, so gating always uses a fresh plan (including right after a reinstall or a plan change).
 */
export async function adminWithPlan(request: Request) {
  const ctx = await authenticate.admin(request);
  const shop = ctx.session.shop;
  await ensureShop(shop);
  const { plan, subscriptions } = await syncPlan(shop, ctx.admin.graphql as GraphQL);
  return { ...ctx, shop, plan, subscriptions };
}
