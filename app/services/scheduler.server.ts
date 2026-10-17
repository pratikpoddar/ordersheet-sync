import db from "../db.server";
import { config } from "../config.server";
import { Deadline, planSweep } from "../lib/jobs";
import { isReconcileDue } from "../lib/schedule";
import { runJobChunk, startJob, type ChunkOutcome } from "./jobs.server";
import { adminFor, fetchActivePlanNames } from "./shopifyOrders.server";
import { setPlanFromSubscriptions } from "./shopData.server";
import { processDirtyOrders, processPendingRedactions } from "./webhookSync.server";

/**
 * One run of the Netlify scheduled function (every 15 minutes, 30s platform limit).
 * Replaces the in-process node-cron sweep. Work is done in bounded slices, in this order:
 *   1. queued customers/redact requests (compliance)
 *   2. dirty orders from webhooks that could not be written inline (Pro)
 *   3. plan refresh for shops whose cached plan is older than 6h
 *   4. start a reconcile job for every shop that is due (Free daily, Pro hourly)
 *   5. advance running jobs (oldest progress first) until the budget is used
 * Jobs persist their cursor, so a 100k-order backfill simply spans several invocations.
 */

const PLAN_RECHECK_MS = 6 * 60 * 60_000;
/** Max time one shop's job gets per sweep, so many shops share the budget fairly. */
const PER_SHOP_SLICE_MS = 15_000;
/** Don't start a chunk with less than this left. */
const MIN_CHUNK_MS = 6_000;
/** Kept free at the end of the budget for the hard-timeout grace and DB disconnects. */
const TAIL_RESERVE_MS = 3_000;

export interface SweepSummary {
  redactions: number;
  dirtyShops: number;
  planChecks: number;
  started: string[];
  chunks: { shop: string; status: ChunkOutcome["status"] }[];
  msUsed: number;
}

export async function runScheduledSweep(opts: { budgetMs?: number; now?: Date } = {}): Promise<SweepSummary> {
  const t0 = Date.now();
  const deadline = new Deadline(opts.budgetMs ?? config.budgets.scheduledMs());
  const now = opts.now ?? new Date();
  const summary: SweepSummary = { redactions: 0, dirtyShops: 0, planChecks: 0, started: [], chunks: [], msUsed: 0 };

  // 1. Compliance redactions
  try {
    summary.redactions = await processPendingRedactions(deadline.slice(5_000));
  } catch (e) {
    console.error("[sweep] redactions failed", e);
  }

  // 2. Dirty orders
  const dirty = await db.dirtyOrder.findMany({ distinct: ["shop"], select: { shop: true }, orderBy: { shop: "asc" } });
  for (const { shop } of dirty) {
    if (!deadline.hasTimeFor(MIN_CHUNK_MS + TAIL_RESERVE_MS)) break;
    try {
      await processDirtyOrders(shop, deadline.slice(8_000));
      summary.dirtyShops++;
    } catch (e) {
      console.error(`[sweep] dirty orders failed for ${shop}`, e);
    }
  }

  // 3 + 4. Due shops
  const [configs, conns, shops] = await Promise.all([
    db.syncConfig.findMany({
      where: { OR: [{ spreadsheetId: { not: null } }, { jobId: { not: null } }] },
      select: { shop: true, jobId: true, jobUpdatedAt: true, lastReconciledAt: true, lastErrorAt: true },
    }),
    db.googleConnection.findMany({ select: { shop: true } }),
    db.shop.findMany({ select: { shop: true, plan: true, planCheckedAt: true } }),
  ]);
  const connected = new Set(conns.map((c) => c.shop));
  const shopRows = new Map(shops.map((s) => [s.shop, s]));

  const stale = configs
    .filter((c) => connected.has(c.shop) && shopRows.has(c.shop))
    .filter((c) => {
      const checked = shopRows.get(c.shop)!.planCheckedAt;
      return !checked || now.getTime() - checked.getTime() > PLAN_RECHECK_MS;
    })
    .sort((a, b) => (shopRows.get(a.shop)!.planCheckedAt?.getTime() ?? 0) - (shopRows.get(b.shop)!.planCheckedAt?.getTime() ?? 0));
  for (const c of stale) {
    if (!deadline.hasTimeFor(MIN_CHUNK_MS + TAIL_RESERVE_MS)) break;
    try {
      const plan = await setPlanFromSubscriptions(c.shop, await fetchActivePlanNames(await adminFor(c.shop)));
      shopRows.set(c.shop, { ...shopRows.get(c.shop)!, plan, planCheckedAt: new Date() });
      summary.planChecks++;
    } catch (e) {
      console.warn(`[sweep] plan refresh failed for ${c.shop}`, e);
    }
  }

  const plan = planSweep(
    configs
      .filter((c) => connected.has(c.shop) && shopRows.has(c.shop))
      .map((c) => ({
        shop: c.shop,
        hasJob: Boolean(c.jobId),
        jobUpdatedAt: c.jobUpdatedAt,
        reconcileDue: isReconcileDue(
          { plan: shopRows.get(c.shop)!.plan === "PRO" ? "PRO" : "FREE", lastReconciledAt: c.lastReconciledAt, lastErrorAt: c.lastErrorAt },
          now,
        ),
      })),
  );
  for (const shop of plan.start) {
    if (!deadline.hasTimeFor(TAIL_RESERVE_MS + 1_000)) break;
    try {
      const r = await startJob(shop, "RECONCILE");
      if (r.status === "STARTED") summary.started.push(shop);
    } catch (e) {
      console.error(`[sweep] could not start reconcile for ${shop}`, e);
    }
  }

  // 5. Advance jobs: running ones first (oldest progress), then the ones just started.
  for (const shop of [...plan.continue, ...summary.started]) {
    if (!deadline.hasTimeFor(MIN_CHUNK_MS + TAIL_RESERVE_MS)) break;
    const slice = Math.min(PER_SHOP_SLICE_MS, deadline.remaining() - TAIL_RESERVE_MS);
    try {
      const r = await runJobChunk(shop, slice, { hardGraceMs: TAIL_RESERVE_MS - 500 });
      summary.chunks.push({ shop, status: r.status });
    } catch (e) {
      console.error(`[sweep] chunk failed for ${shop}`, e);
    }
  }

  summary.msUsed = Date.now() - t0;
  return summary;
}
