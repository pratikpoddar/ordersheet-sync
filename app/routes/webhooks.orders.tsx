import type { ActionFunctionArgs } from "react-router";
import { config } from "../config.server";
import { runInlineWithGuard } from "../lib/jobs";
import { orderIdFromGid } from "../lib/normalize";
import { waitUntilFrom } from "../lib/platform";
import { authenticate } from "../shopify.server";
import { markDirty, syncOrderFromWebhook } from "../services/webhookSync.server";

/**
 * orders/create and orders/updated (see shopify.app.toml).
 *
 * Serverless: nothing survives in memory after the response, so there is no queue. We
 *   1. verify the HMAC (authenticate.webhook throws a 401 Response if it is invalid),
 *   2. re-fetch the order and upsert its row inline, under a timeout guard (Shopify allows 5s),
 *   3. on timeout or error, record the order in DirtyOrder for the scheduled function,
 *   4. always answer 200, so Shopify never retries or disables the subscription because of us.
 */
export const action = async ({ request, context }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const raw = (payload as any)?.id ?? (payload as any)?.admin_graphql_api_id;
  if (!raw) {
    console.warn(`[webhook] ${topic} for ${shop} without an order id`);
    return new Response();
  }
  const orderId = orderIdFromGid(raw);
  const outcome = await runInlineWithGuard(() => syncOrderFromWebhook(shop, orderId), {
    timeoutMs: config.budgets.webhookInlineMs(),
    onDefer: async (reason, error) => {
      if (error) console.error(`[webhook] ${topic} ${orderId} for ${shop} failed inline`, error);
      await markDirty(shop, [orderId], reason === "timeout" ? "inline timeout" : "inline error");
    },
    waitUntil: waitUntilFrom(context),
    tailMs: config.budgets.webhookTailMs(),
  });
  if (outcome !== "DONE") console.warn(`[webhook] ${topic} ${orderId} for ${shop}: ${outcome}, deferred to the scheduled sync`);
  return new Response();
};
