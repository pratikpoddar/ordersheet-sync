import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { isProSubscription, pricingPlansUrl } from "../lib/plans";
import { adminWithPlan } from "../services/planSync.server";
import { setPlan } from "../services/shopData.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { plan, subscriptions } = await adminWithPlan(request);
  const active = subscriptions.find((s) => s.status === "ACTIVE" && isProSubscription(s));
  return {
    plan,
    trialDays: active?.trialDays ?? null,
    test: active?.test ?? false,
    renews: active?.currentPeriodEnd ?? null,
  };
};

const CANCEL = `#graphql
  mutation Cancel($id: ID!) {
    appSubscriptionCancel(id: $id, prorate: true) { userErrors { field message } appSubscription { id status } }
  }`;

/**
 * Plan changes go through Shopify's hosted plan page (Managed Pricing): it shows the approval
 * screen, starts the 7-day trial, puts the charge in the store's billing history, and lets the
 * merchant decline (they come back on Free and can try again) or switch back to Free.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, subscriptions, redirect, admin } = await adminWithPlan(request);
  const intent = String((await request.formData()).get("intent"));
  const hosted = pricingPlansUrl(shop);

  if (intent === "downgrade") {
    const subs = subscriptions.filter((s) => s.status === "ACTIVE" && isProSubscription(s));
    try {
      for (const sub of subs) {
        const res = await admin.graphql(CANCEL, { variables: { id: sub.id } });
        const json = (await res.json()) as any;
        const errs = json?.data?.appSubscriptionCancel?.userErrors ?? json?.errors;
        if (errs?.length) throw new Error(JSON.stringify(errs));
      }
      await setPlan(shop, "FREE");
      return { ok: true, message: "You're on the Free plan now. Pro features stop right away." };
    } catch (err) {
      if (err instanceof Response) throw err;
      console.error(`[billing] ${shop}: direct cancel failed, sending to hosted plan page`, err);
      return redirect(hosted, { target: "_top" });
    }
  }

  // "upgrade" and "change": Shopify's hosted plan selection page.
  console.log(`[billing] ${shop}: opening hosted plan page (${intent})`);
  return redirect(hosted, { target: "_top" });
};

export default function Plans() {
  const { plan, trialDays, test } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { ok?: boolean; message?: string } | undefined;
  const nav = useNavigation();
  const busy = nav.state !== "idle";
  return (
    <s-page heading="Plans">
      {actionData?.message && <s-banner tone="success">{actionData.message}</s-banner>}
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
            {plan === "FREE" ? (
              <s-badge>Current plan</s-badge>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="downgrade" />
                <s-button type="submit" variant="secondary" loading={busy}>Downgrade to Free</s-button>
              </Form>
            )}
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
              <s-stack gap="small-200">
                <s-badge tone="success">Current plan{test ? " (test charge)" : ""}</s-badge>
                {trialDays ? <s-text>Includes a {trialDays}-day free trial.</s-text> : null}
                <Form method="post">
                  <input type="hidden" name="intent" value="change" />
                  <s-button type="submit" variant="tertiary" loading={busy}>Manage plan in Shopify</s-button>
                </Form>
              </s-stack>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="upgrade" />
                <s-button type="submit" variant="primary" loading={busy}>Start 7-day free trial</s-button>
              </Form>
            )}
          </s-stack>
        </s-section>
      </s-grid>
      <s-paragraph>
        Billed through Shopify: charges appear on your Shopify bill. You can upgrade, downgrade or cancel
        here anytime, with no reinstall needed.
      </s-paragraph>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
