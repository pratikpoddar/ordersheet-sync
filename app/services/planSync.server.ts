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
  const check = await ctx.billing.check({ plans: [PRO_PLAN], isTest: config.billingTest() });
  const plan = await setPlanFromSubscriptions(
    shop,
    check.appSubscriptions.filter((s) => s.status === "ACTIVE").map((s) => s.name),
  );
  return { ...ctx, shop, plan, subscriptions: check.appSubscriptions };
}
