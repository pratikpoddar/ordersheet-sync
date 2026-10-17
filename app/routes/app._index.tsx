import { useEffect, useRef } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import db from "../db.server";
import { entitlementsFor } from "../lib/plans";
import { buildGoogleAuthUrl, revokeAndDelete } from "../services/google.server";
import { adminWithPlan } from "../services/planSync.server";
import { getOrCreateConfig } from "../services/shopData.server";
import { config } from "../config.server";
import { jobStatusFrom, runJobChunk, startJob, type ChunkOutcome } from "../services/jobs.server";

const MANUAL_COOLDOWN_MS = 2 * 60_000;

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { shop, plan } = await adminWithPlan(request);
  const [cfg, google, logs] = await Promise.all([
    getOrCreateConfig(shop),
    db.googleConnection.findUnique({ where: { shop } }),
    db.syncLog.findMany({ where: { shop }, orderBy: { startedAt: "desc" }, take: 15 }),
  ]);
  const ent = entitlementsFor(plan);
  return {
    shop,
    plan,
    ent,
    google: google ? { email: google.email, connectedAt: google.connectedAt.toISOString() } : null,
    sheet: cfg.spreadsheetUrl ? { url: cfg.spreadsheetUrl } : null,
    job: jobStatusFrom(cfg),
    status: {
      syncing: Boolean(cfg.jobId),
      lastSuccessAt: cfg.lastSuccessAt?.toISOString() ?? null,
      lastError: cfg.lastError,
      lastErrorAt: cfg.lastErrorAt?.toISOString() ?? null,
      rowCount: cfg.rowCount,
    },
    logs: logs.map((l) => ({
      id: l.id,
      kind: l.kind,
      status: l.status,
      startedAt: l.startedAt.toISOString(),
      rowsWritten: l.rowsWritten,
      message: l.message,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop } = await adminWithPlan(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "connectGoogle") {
    return { authUrl: buildGoogleAuthUrl(shop) };
  }
  if (intent === "disconnectGoogle") {
    await revokeAndDelete(shop);
    await db.syncConfig.updateMany({
      where: { shop },
      data: {
        spreadsheetId: null, spreadsheetUrl: null, sheetGid: null, lastSuccessAt: null, rowCount: 0, layoutVersion: null,
        // Drop any running job; it can't write without Google.
        jobId: null, jobKind: null, jobPhase: null, jobCursor: null, jobParams: null, jobLogId: null, syncing: false,
      },
    });
    await db.dirtyOrder.deleteMany({ where: { shop } });
    return { ok: true, message: "Google disconnected" };
  }
  if (intent === "continue") {
    // Sent by the dashboard while a job runs, so large syncs move faster than the 15-min scheduler.
    const r = await runJobChunk(shop, config.budgets.continueMs());
    return { continued: r.status };
  }
  if (intent === "sync" || intent === "rebuild") {
    const cfg = await getOrCreateConfig(shop);
    if (!(await db.googleConnection.findUnique({ where: { shop } }))) {
      return { ok: false, message: "Connect Google first" };
    }
    if (cfg.jobId && intent === "sync") return { ok: false, message: "A sync is already running" };
    if (cfg.lastManualSyncAt && Date.now() - cfg.lastManualSyncAt.getTime() < MANUAL_COOLDOWN_MS) {
      return { ok: false, message: "Please wait a couple of minutes between manual syncs" };
    }
    await db.syncConfig.update({ where: { shop }, data: { lastManualSyncAt: new Date() } });
    const started =
      intent === "rebuild"
        ? await startJob(shop, "REBUILD", { rebuild: true, replace: true })
        : await startJob(shop, "MANUAL");
    if (started.status !== "STARTED") return { ok: false, message: started.reason ?? "A sync is already running" };
    // Process one bounded chunk inside this request (Netlify: 60s); the rest continues from the
    // saved cursor via the dashboard poll and the scheduled function.
    const r = await runJobChunk(shop, config.budgets.manualMs());
    return manualResult(intent, r);
  }
  return { ok: false, message: "Unknown action" };
};

function manualResult(intent: string, r: ChunkOutcome) {
  const what = intent === "rebuild" ? "Rebuild" : "Sync";
  switch (r.status) {
    case "DONE":
      return { ok: true, message: `${what} complete: ${r.progress?.rowsWritten ?? 0} row(s) written` };
    case "PAUSED":
      return { ok: true, message: `${what} in progress: ${r.progress?.rowsWritten ?? 0} row(s) so far. It keeps going in the background.` };
    case "FAILED":
    case "RETRY":
      return { ok: false, message: r.message };
    default:
      return { ok: true, message: `${what} started` };
  }
}

const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
const jobLabel = (j: { kind: string; phase: string; full: boolean | null }) =>
  j.phase === "PREPARE"
    ? "Preparing your sheet"
    : j.kind === "REBUILD" || j.kind === "BACKFILL" || j.full
      ? "Importing orders"
      : "Syncing recent changes";

const tone = (s: string) =>
  s === "SUCCESS" ? "success" : s === "ERROR" ? "critical" : s === "RUNNING" ? "info" : "neutral";

export default function Dashboard() {
  const data = useLoaderData<typeof loader>();
  const fetcher = useFetcher<{ ok?: boolean; message?: string; authUrl?: string }>();
  const runner = useFetcher<{ continued?: string }>();
  const shopify = useAppBridge();
  const revalidator = useRevalidator();
  const busy = fetcher.state !== "idle";

  useEffect(() => {
    if (fetcher.data?.authUrl) {
      // Google's consent screen cannot be framed; open it in a new tab.
      window.open(fetcher.data.authUrl, "_blank", "noopener");
    } else if (fetcher.data?.message) {
      shopify.toast.show(fetcher.data.message, { isError: fetcher.data.ok === false });
    }
  }, [fetcher.data, shopify]);

  // While a job runs and this page is open, keep advancing it in ~20s chunks (one at a time),
  // so a big backfill doesn't wait for the 15-minute scheduled function.
  const hasJob = Boolean(data.job);
  const runnerSubmit = useRef(runner.submit);
  runnerSubmit.current = runner.submit;
  useEffect(() => {
    if (!hasJob || runner.state !== "idle" || busy) return;
    // Back off when another invocation (e.g. the scheduled function) holds the sheet.
    const delay = runner.data?.continued === "LOCKED" ? 8000 : 1500;
    const t = setTimeout(() => runnerSubmit.current({ intent: "continue" }, { method: "POST" }), delay);
    return () => clearTimeout(t);
  }, [hasJob, runner.state, runner.data, busy]);

  // Poll while a sync runs, and every 10s after connecting so the new sheet shows up.
  useEffect(() => {
    if (!data.status.syncing && data.google && data.sheet) return;
    const t = setInterval(() => revalidator.revalidate(), data.status.syncing ? 3000 : 10000);
    return () => clearInterval(t);
  }, [data.status.syncing, data.google, data.sheet, revalidator]);

  const submit = (intent: string) => fetcher.submit({ intent }, { method: "POST" });

  return (
    <s-page heading="OrderSheet Sync">
      {data.google && (
        <s-button slot="primary-action" variant="primary" onClick={() => submit("sync")} loading={busy || data.status.syncing} disabled={data.status.syncing}>
          Sync now
        </s-button>
      )}

      {data.status.lastError && (
        <s-banner tone="critical" heading="Last sync failed">
          <s-paragraph>{data.status.lastError}</s-paragraph>
          <s-paragraph>Failed at {fmt(data.status.lastErrorAt)}. We retry automatically.</s-paragraph>
        </s-banner>
      )}

      <s-section heading="1. Connect Google Sheets">
        {data.google ? (
          <s-stack gap="base">
            <s-paragraph>
              Connected as <s-text type="strong">{data.google.email ?? "your Google account"}</s-text>. OrderSheet Sync can only see the spreadsheet it creates.
            </s-paragraph>
            <s-button variant="tertiary" tone="critical" onClick={() => submit("disconnectGoogle")}>Disconnect Google</s-button>
          </s-stack>
        ) : (
          <s-stack gap="base">
            <s-paragraph>
              We create one new spreadsheet in your Google Drive and keep it updated. We never get access to your other files.
            </s-paragraph>
            <s-button variant="primary" onClick={() => submit("connectGoogle")} loading={busy}>Connect Google</s-button>
          </s-stack>
        )}
      </s-section>

      <s-section heading="2. Your orders sheet">
        {data.sheet ? (
          <s-stack gap="base">
            <s-link href={data.sheet.url} target="_blank">Open Google Sheet</s-link>
            <s-paragraph>
              {data.job
                ? `${jobLabel(data.job)}: ${data.job.pages} page(s) read, ${data.job.rowsWritten} row(s) written so far (last progress ${fmt(data.job.updatedAt)}). ${data.status.rowCount} orders in the sheet.`
                : `${data.status.rowCount} orders in the sheet. Last successful sync: ${fmt(data.status.lastSuccessAt)}.`}
            </s-paragraph>
            <s-paragraph>
              {data.ent.realtimeWebhooks
                ? "New and updated orders appear within seconds, with an hourly safety check."
                : "Free plan: synced once a day, last 60 days. Upgrade for near real-time updates and full history."}
            </s-paragraph>
            <s-button variant="secondary" onClick={() => submit("rebuild")} disabled={data.status.syncing}>Rebuild sheet from scratch</s-button>
          </s-stack>
        ) : (
          <s-paragraph>
            {!data.google
              ? "Connect Google to create your sheet."
              : data.job
                ? "Creating your sheet and importing orders…"
                : "Your sheet hasn't been created yet. Click Sync now to create it."}
          </s-paragraph>
        )}
      </s-section>

      <s-section heading="Sync log">
        {data.logs.length === 0 ? (
          <s-paragraph>No syncs yet.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>When</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Rows written</s-table-header>
              <s-table-header>Details</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {data.logs.map((l) => (
                <s-table-row key={l.id}>
                  <s-table-cell>{fmt(l.startedAt)}</s-table-cell>
                  <s-table-cell>{l.kind.toLowerCase()}</s-table-cell>
                  <s-table-cell><s-badge tone={tone(l.status)}>{l.status.toLowerCase()}</s-badge></s-table-cell>
                  <s-table-cell>{l.rowsWritten}</s-table-cell>
                  <s-table-cell>{l.message ?? ""}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>

      <s-section slot="aside" heading="Plan">
        <s-stack gap="base">
          <s-badge tone={data.plan === "PRO" ? "success" : "neutral"}>{data.plan === "PRO" ? "Pro" : "Free"}</s-badge>
          {data.plan === "FREE" && <s-link href="/app/plans">Try Pro free for 7 days</s-link>}
        </s-stack>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
