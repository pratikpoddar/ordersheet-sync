import type { ActionFunctionArgs } from "react-router";
import { config } from "../config.server";
import { runInlineWithGuard } from "../lib/jobs";
import { waitUntilFrom } from "../lib/platform";
import { authenticate } from "../shopify.server";
import { queueRedactions, redactNow } from "../services/webhookSync.server";

/**
 * GDPR customers/redact. We hold no customer data in our database. If customer columns are
 * enabled, we also blank those cells in the merchant's sheet for the listed orders: inline when
 * possible, otherwise queued (PendingRedaction) for the scheduled function. Always 200.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const orders: string[] = ((payload as any)?.orders_to_redact ?? []).map(String);
  if (!orders.length) return new Response();
  await runInlineWithGuard(() => redactNow(shop, orders), {
    timeoutMs: config.budgets.webhookInlineMs(),
    onDefer: async (_reason, error) => {
      if (error) console.warn(`[compliance] redact deferred for ${shop}: ${(error as Error)?.message ?? error}`);
      await queueRedactions(shop, orders);
    },
    waitUntil: waitUntilFrom(context),
    tailMs: config.budgets.webhookTailMs(),
  });
  return new Response();
};
