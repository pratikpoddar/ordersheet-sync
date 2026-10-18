import { PRO_PLAN } from "../lib/plans";
import { config } from "../config.server";
import { authenticate } from "../shopify.server";
import { ensureShop, setPlanFromSubscriptions } from "./shopData.server";

/**
 * Authenticate an embedded admin request and refresh the cached plan from the
 * Billing API. Every loader/action uses this, so gating always uses a fresh plan.
 */
export async function adminWithPlan(request: Request) {
  const ctx = await authenticate.admin(request);
  const shop = ctx.session.shop;
  await ensureShop(shop);
  const isDevStore = await isDevelopmentStore(ctx.admin);
  const isTest = config.billingTest(isDevStore);
  const check = await ctx.billing.check({ plans: [PRO_PLAN], isTest });
  const plan = await setPlanFromSubscriptions(
    shop,
    check.appSubscriptions.filter((s) => s.status === "ACTIVE").map((s) => s.name),
  );
  return { ...ctx, shop, plan, isTest, subscriptions: check.appSubscriptions };
}

/** True for development / partner test stores, where Shopify only accepts test charges. */
async function isDevelopmentStore(admin: { graphql: (q: string) => Promise<Response> }) {
  try {
    const res = await admin.graphql(`#graphql
      query { shop { plan { partnerDevelopment } } }`);
    const json = (await res.json()) as { data?: { shop?: { plan?: { partnerDevelopment?: boolean } } } };
    return Boolean(json.data?.shop?.plan?.partnerDevelopment);
  } catch {
    return false;
  }
}
