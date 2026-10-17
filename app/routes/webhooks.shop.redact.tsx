import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { purgeShop } from "../services/shopData.server";

/** GDPR shop/redact (48h after uninstall): delete everything for the shop. */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await authenticate.webhook(request);
  await purgeShop(shop);
  return new Response();
};
