import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { config } from "../config.server";
import { PRO_PLAN } from "../lib/plans";
import { adminWithPlan } from "../services/planSync.server";
import { setPlanFromSubscriptions } from "../services/shopData.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { plan, subscriptions } = await adminWithPlan(request);
  const active = subscriptions.find((s) => s.name === PRO_PLAN && s.status === "ACTIVE");
  return { plan, trialDays: active?.trialDays ?? null };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { billing, shop, subscriptions, session } = await adminWithPlan(request);
  const intent = String((await request.formData()).get("intent"));
  if (intent === "upgrade") {
    // Throws a redirect to Shopify's approval page (handled by the library inside the iframe).
    await billing.request({
      plan: PRO_PLAN,
      isTest: config.billingTest(),
      returnUrl: `https://admin.shopify.com/store/${session.shop.replace(".myshopify.com", "")}/apps/${config.apiKey()}/app`,
    });
  }
  if (intent === "cancel") {
    const sub = subscriptions.find((s) => s.name === PRO_PLAN && s.status === "ACTIVE");
    if (sub) {
      await billing.cancel({ subscriptionId: sub.id, isTest: config.billingTest(), prorate: true });
      await setPlanFromSubscriptions(shop, []);
    }
    return { ok: true };
  }
  return null;
};

export default function Plans() {
  const { plan } = useLoaderData<typeof loader>();
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <s-page heading="Plans">
      <s-grid gridTemplateColumns="1fr 1fr" gap="base">
        <s-section heading="Free">
          <s-stack gap="small-200">
            <s-text type="strong">$0</s-text>
            <s-unordered-list>
              <s-list-item>1 Google Sheet</s-list-item>
              <s-list-item>Last 60 days of orders</s-list-item>
              <s-list-item>Daily automatic sync + Sync now</s-list-item>
              <s-list-item>12 default columns</s-list-item>
            </s-unordered-list>
            {plan === "FREE" && <s-badge>Current plan</s-badge>}
          </s-stack>
        </s-section>
        <s-section heading="Pro">
          <s-stack gap="small-200">
            <s-text type="strong">$7 / month · 7-day free trial</s-text>
            <s-unordered-list>
              <s-list-item>Unlimited order history</s-list-item>
              <s-list-item>Near real-time sync (seconds after each order)</s-list-item>
              <s-list-item>Choose your columns, incl. SKUs, tags, source</s-list-item>
              <s-list-item>Payment, fulfillment, test and cancelled filters</s-list-item>
            </s-unordered-list>
            {plan === "PRO" ? (
              <Form method="post">
                <input type="hidden" name="intent" value="cancel" />
                <s-stack gap="small-200">
                  <s-badge tone="success">Current plan</s-badge>
                  <s-button type="submit" variant="tertiary" tone="critical" loading={busy}>Cancel Pro</s-button>
                </s-stack>
              </Form>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="upgrade" />
                <s-button type="submit" variant="primary" loading={busy}>Start 7-day free trial</s-button>
              </Form>
            )}
          </s-stack>
        </s-section>
      </s-grid>
      <s-paragraph>Billed through Shopify. Cancel anytime from this page.</s-paragraph>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
