import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { purgeShop } from "../services/shopData.server";

/**
 * Uninstall: revoke the Google token and delete every record we hold for the shop.
 * Safe to run more than once (Shopify may retry). The merchant's spreadsheet stays
 * in their own Google Drive; we simply lose access to it.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);
  await purgeShop(shop);
  return new Response();
};
