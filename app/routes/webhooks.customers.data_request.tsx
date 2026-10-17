import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

/**
 * GDPR customers/data_request. OrderSheet Sync stores no customer personal data in its
 * own database: order rows are written straight to the merchant's spreadsheet, which the
 * merchant owns and can search. We acknowledge and log the request.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const p = payload as any;
  console.log(
    `[compliance] customers/data_request for ${shop}: customer ${p?.customer?.id ?? "?"}, orders ${JSON.stringify(p?.orders_requested ?? [])}. No customer data is stored by the app.`,
  );
  return new Response();
};
