import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { tierFromSubscriptions } from "../lib/plans";
import { getPlan, setPlan } from "../services/shopData.server";
import { fetchActiveSubscriptions } from "../services/planSync.server";
import { startJob } from "../services/jobs.server";

/**
 * Keeps the cached plan in step with Shopify billing (approval, plan change, downgrade, freeze).
 * The payload describes one subscription; a plan switch sends events for both the old and the new
 * one in any order, so we re-read the shop's active subscriptions when we can.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload, admin } = await authenticate.webhook(request);
  const sub = (payload as any)?.app_subscription;
  const before = await getPlan(shop);
  let tier;
  try {
    if (!admin) throw new Error("no offline session");
    tier = tierFromSubscriptions(await fetchActiveSubscriptions(admin.graphql as any));
  } catch (e) {
    console.warn(`[billing webhook] ${shop}: falling back to payload`, e);
    tier = sub ? tierFromSubscriptions([{ name: sub.name, status: sub.status }]) : before;
  }
  const after = await setPlan(shop, tier);
  // Downgrade or upgrade changes the allowed layout/history: record a re-sync job (no API work
  // here, so we answer fast); the scheduled function or the dashboard runs it.
  if (before !== after) await startJob(shop, "RECONCILE", { replace: true });
  return new Response();
};
