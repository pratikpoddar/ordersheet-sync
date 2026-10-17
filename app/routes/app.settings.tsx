import { useEffect, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { config } from "../config.server";
import { COLUMNS, DEFAULT_COLUMNS } from "../lib/columns";
import { FINANCIAL_STATUSES, FULFILLMENT_STATUSES } from "../lib/filters";
import { entitlementsFor, sanitizeSettings } from "../lib/plans";
import { humanizeStatus } from "../lib/rowMapping";
import { adminWithPlan } from "../services/planSync.server";
import { effectiveSettings, getOrCreateConfig, layoutKey } from "../services/shopData.server";
import { startJob } from "../services/jobs.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, plan } = await adminWithPlan(request);
  const eff = await effectiveSettings(shop);
  return {
    plan,
    ent: entitlementsFor(plan),
    protectedDataEnabled: config.protectedCustomerData(),
    settings: { columns: eff.columns, filters: eff.filters, backfillFrom: eff.backfillFrom, backfillTo: eff.backfillTo },
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, plan } = await adminWithPlan(request);
  const body = await request.json();
  // Server-side gate: the plan decides what is stored, whatever the client sent.
  const eff = sanitizeSettings(
    plan,
    {
      columns: Array.isArray(body.columns) ? body.columns : DEFAULT_COLUMNS,
      backfillFrom: body.backfillFrom || null,
      backfillTo: body.backfillTo || null,
      filters: body.filters ?? {},
    },
    { protectedDataEnabled: config.protectedCustomerData() },
  );
  const before = await getOrCreateConfig(shop);
  await db.syncConfig.update({
    where: { shop },
    data: {
      columns: JSON.stringify(eff.columns),
      filters: JSON.stringify(eff.filters),
      backfillFrom: eff.backfillFrom,
      backfillTo: eff.backfillTo,
    },
  });
  const connected = await db.googleConnection.findUnique({ where: { shop } });
  // Layout changed: record a rebuild job, replacing any running one (it would write the old layout).
  // No API work here; the dashboard and the scheduled function run the job in bounded chunks.
  const changed = before.layoutVersion !== layoutKey(eff.columns, eff.filters, eff.backfillFrom, eff.backfillTo);
  const rebuilding = Boolean(connected && changed && (before.spreadsheetId || before.jobId));
  if (rebuilding) await startJob(shop, "REBUILD", { replace: true });
  return { ok: true, clamped: eff.clamped, rebuilding };
};

export default function Settings() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const shopify = useAppBridge();
  const [columns, setColumns] = useState<string[]>(data.settings.columns);
  const [financial, setFinancial] = useState<string[]>(data.settings.filters.financial);
  const [fulfillment, setFulfillment] = useState<string[]>(data.settings.filters.fulfillment);
  const [includeTest, setIncludeTest] = useState(data.settings.filters.includeTest);
  const [includeCancelled, setIncludeCancelled] = useState(data.settings.filters.includeCancelled);
  const [from, setFrom] = useState(data.settings.backfillFrom ?? "");
  const [to, setTo] = useState(data.settings.backfillTo ?? "");
  const pro = data.ent.customColumns;

  useEffect(() => {
    if (fetcher.data?.ok) {
      const extra = fetcher.data.clamped?.length ? ` ${fetcher.data.clamped.join(" ")}` : "";
      shopify.toast.show(`Settings saved.${fetcher.data.rebuilding ? " Your sheet is being rebuilt; progress shows on the dashboard." : ""}${extra}`);
    }
  }, [fetcher.data, shopify]);

  const toggle = (list: string[], set: (v: string[]) => void, v: string, on: boolean) =>
    set(on ? [...new Set([...list, v])] : list.filter((x) => x !== v));

  const save = () =>
    fetcher.submit(
      { columns, backfillFrom: from || null, backfillTo: to || null, filters: { financial, fulfillment, includeTest, includeCancelled } },
      { method: "POST", encType: "application/json" },
    );

  return (
    <s-page heading="Settings">
      <s-button slot="primary-action" variant="primary" onClick={save} loading={fetcher.state !== "idle"}>Save</s-button>

      {!pro && (
        <s-banner tone="info" heading="You're on the Free plan">
          <s-paragraph>
            Free includes the default columns and the last 60 days of orders. <s-link href="/app/plans">Upgrade to Pro</s-link> for custom columns, full history, filters and real-time sync.
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Columns">
        <s-paragraph>Column A is always the Shopify order ID, so each order stays on exactly one row.</s-paragraph>
        <s-stack gap="small-200">
          {COLUMNS.map((c) => {
            const locked = c.protectedData && !data.protectedDataEnabled;
            return (
              <s-checkbox
                key={c.key}
                label={c.label}
                details={locked ? "Needs Shopify protected customer data approval" : undefined}
                checked={columns.includes(c.key)}
                disabled={!pro || locked}
                onChange={(e) => toggle(columns, setColumns, c.key, e.currentTarget.checked)}
              />
            );
          })}
        </s-stack>
      </s-section>

      <s-section heading="Backfill date range">
        <s-paragraph>
          Orders created in this range are imported when the sheet is built. New orders are always added.
          {!pro && " Free plan: limited to the last 60 days."}
        </s-paragraph>
        <s-stack direction="inline" gap="base">
          <s-date-field label="From" value={from} onChange={(e) => setFrom(e.currentTarget.value)} />
          <s-date-field label="To (optional)" value={to} disabled={!pro} onChange={(e) => setTo(e.currentTarget.value)} />
        </s-stack>
      </s-section>

      <s-section heading="Order filters">
        <s-paragraph>Leave everything unticked to export all orders.{!pro && " Filters are a Pro feature."}</s-paragraph>
        <s-stack direction="inline" gap="large">
          <s-stack gap="small-200">
            <s-text type="strong">Payment status</s-text>
            {FINANCIAL_STATUSES.map((s) => (
              <s-checkbox key={s} label={humanizeStatus(s)} checked={financial.includes(s)} disabled={!pro}
                onChange={(e) => toggle(financial, setFinancial, s, e.currentTarget.checked)} />
            ))}
          </s-stack>
          <s-stack gap="small-200">
            <s-text type="strong">Fulfillment status</s-text>
            {FULFILLMENT_STATUSES.map((s) => (
              <s-checkbox key={s} label={humanizeStatus(s)} checked={fulfillment.includes(s)} disabled={!pro}
                onChange={(e) => toggle(fulfillment, setFulfillment, s, e.currentTarget.checked)} />
            ))}
          </s-stack>
          <s-stack gap="small-200">
            <s-text type="strong">Other</s-text>
            <s-checkbox label="Include cancelled orders" checked={includeCancelled} disabled={!pro}
              onChange={(e) => setIncludeCancelled(e.currentTarget.checked)} />
            <s-checkbox label="Include test orders" checked={includeTest} disabled={!pro}
              onChange={(e) => setIncludeTest(e.currentTarget.checked)} />
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
