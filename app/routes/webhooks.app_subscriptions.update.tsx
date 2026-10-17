import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { PRO_PLAN } from "../lib/plans";
import { getPlan, setPlanFromSubscriptions } from "../services/shopData.server";
import { startJob } from "../services/jobs.server";

/** Keeps the cached plan in step with Shopify billing (activation, cancellation, freeze). */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const sub = (payload as any)?.app_subscription;
  if (sub?.name === PRO_PLAN) {
    const before = await getPlan(shop);
    const after = await setPlanFromSubscriptions(shop, sub.status === "ACTIVE" ? [PRO_PLAN] : []);
    // Downgrade or upgrade changes the allowed layout/history: record a re-sync job (no API work
    // here, so we answer fast); the scheduled function or the dashboard runs it.
    if (before !== after) await startJob(shop, "RECONCILE", { replace: true });
  }
  return new Response();
};
