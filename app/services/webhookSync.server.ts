import db from "../db.server";
import { config } from "../config.server";
import { Deadline, raceTimeout } from "../lib/jobs";
import type { NormalizedOrder } from "../lib/normalize";
import { entitlementsFor } from "../lib/plans";
import { startJob } from "./jobs.server";
import { adminFor, fetchOrderById } from "./shopifyOrders.server";
import { effectiveSettings, layoutKey } from "./shopData.server";
import {
  acquireLease,
  finishLog,
  friendlyError,
  redactOrdersInSheet,
  releaseLease,
  SheetSession,
  splitByFilters,
  startLog,
} from "./sync.server";

/**
 * Real-time (Pro) path without an in-memory queue.
 * The webhook route calls syncOrderFromWebhook() inline under a timeout guard. Anything that
 * can't be written right away (timeout, sheet locked by a job, API error) is recorded in
 * DirtyOrder; the scheduled function re-fetches and upserts those orders, and any later
 * sync job clears them too.
 */

const WEBHOOK_LEASE_MS = 30_000;
/** More dirty orders than this for one shop: run an incremental reconcile job instead. */
export const DIRTY_BATCH_MAX = 50;

export type WebhookSyncResult = "IGNORED" | "SYNCED" | "DEFERRED";

export async function markDirty(shop: string, orderIds: string[], reason: string) {
  const markedAt = new Date();
  for (const orderId of orderIds) {
    await db.dirtyOrder.upsert({
      where: { shop_orderId: { shop, orderId } },
      create: { shop, orderId, reason, markedAt },
      update: { reason, markedAt },
    });
  }
}

export async function syncOrderFromWebhook(shop: string, orderId: string): Promise<WebhookSyncResult> {
  const eff = await effectiveSettings(shop);
  if (!entitlementsFor(eff.plan).realtimeWebhooks) return "IGNORED"; // Free: daily sync only
  const [cfg, conn] = await Promise.all([
    db.syncConfig.findUnique({ where: { shop } }),
    db.googleConnection.findUnique({ where: { shop } }),
  ]);
  if (!cfg || !conn) return "IGNORED"; // not set up yet; the first backfill will include it

  if (cfg.jobId) {
    // A backfill/rebuild/reconcile owns the sheet right now. Let the sweep handle this order after it.
    await markDirty(shop, [orderId], "sync job running");
    return "DEFERRED";
  }
  if (!cfg.spreadsheetId || cfg.sheetGid === null || !cfg.lastSuccessAt) return "IGNORED";

  // Layout drifted (e.g. settings just changed): a rebuild job writes every order, this one included.
  if (cfg.layoutVersion !== layoutKey(eff.columns, eff.filters, cfg.backfillFrom, cfg.backfillTo)) {
    await startJob(shop, "REBUILD");
    return "DEFERRED";
  }

  const token = await acquireLease(shop, WEBHOOK_LEASE_MS);
  if (!token) {
    await markDirty(shop, [orderId], "sheet busy");
    return "DEFERRED";
  }
  const startedAt = new Date();
  try {
    await upsertOrdersById(shop, [orderId]);
    await db.dirtyOrder.deleteMany({ where: { shop, orderId, markedAt: { lte: startedAt } } });
    return "SYNCED";
  } finally {
    await releaseLease(shop, token).catch(() => {});
  }
}

/**
 * Re-fetches the given orders from the Admin API (never trusts the webhook body, so out-of-order
 * delivery can't write stale data) and upserts them. Caller must hold the shop's lease.
 */
export async function upsertOrdersById(shop: string, orderIds: string[]) {
  const eff = await effectiveSettings(shop);
  const cfg = await db.syncConfig.findUnique({ where: { shop } });
  if (!cfg?.spreadsheetId || cfg.sheetGid === null) return 0;
  const log = await startLog(shop, "WEBHOOK");
  try {
    const graphql = await adminFor(shop);
    const shopRow = await db.shop.findUnique({ where: { shop } });
    const orders: NormalizedOrder[] = [];
    for (const id of orderIds) {
      const o = await fetchOrderById(graphql, id, config.protectedCustomerData());
      if (o) orders.push(o);
    }
    const session = new SheetSession(shop, cfg.spreadsheetId, cfg.sheetTitle, cfg.sheetGid);
    await session.load();
    const { writes, removes } = splitByFilters(
      orders,
      eff.filters,
      { createdFrom: eff.backfillFrom, createdTo: null },
      eff.columns,
      shopRow?.timezone || "UTC",
    );
    await session.upsert(writes, removes);
    await db.syncConfig.update({ where: { shop }, data: { rowCount: session.rowCount, lastError: null, lastErrorAt: null } });
    await finishLog(log.id, shop, "SUCCESS", session.written, `Real-time update: ${orderIds.length} order(s)`);
    return session.written;
  } catch (err) {
    await finishLog(log.id, shop, "ERROR", 0, `${friendlyError(err)} (the scheduled sync will retry)`).catch(() => {});
    throw err;
  }
}

/** Scheduled sweep: write this shop's dirty orders, bounded by `deadline`. */
export async function processDirtyOrders(shop: string, deadline: Deadline): Promise<"DONE" | "SKIPPED" | "JOB" | "TIMEOUT" | "ERROR"> {
  const cfg = await db.syncConfig.findUnique({ where: { shop } });
  const conn = await db.googleConnection.findUnique({ where: { shop } });
  if (!cfg || !conn) {
    await db.dirtyOrder.deleteMany({ where: { shop } });
    return "SKIPPED";
  }
  if (cfg.jobId) return "SKIPPED"; // the running job (or the sweep after it) covers these
  const eff = await effectiveSettings(shop);
  if (!entitlementsFor(eff.plan).realtimeWebhooks) {
    await db.dirtyOrder.deleteMany({ where: { shop } }); // downgraded: daily reconcile covers it
    return "SKIPPED";
  }
  const layoutOk = cfg.layoutVersion === layoutKey(eff.columns, eff.filters, cfg.backfillFrom, cfg.backfillTo);
  const count = await db.dirtyOrder.count({ where: { shop } });
  if (!cfg.spreadsheetId || cfg.sheetGid === null || !cfg.lastSuccessAt || !layoutOk || count > DIRTY_BATCH_MAX) {
    await startJob(shop, layoutOk ? "RECONCILE" : "REBUILD"); // cleared when the job finishes
    return "JOB";
  }
  const rows = await db.dirtyOrder.findMany({ where: { shop }, take: DIRTY_BATCH_MAX });
  if (!rows.length || !deadline.hasTimeFor(3000)) return "SKIPPED";
  const token = await acquireLease(shop, deadline.remaining() + WEBHOOK_LEASE_MS);
  if (!token) return "SKIPPED";
  const startedAt = new Date();
  let abandoned = false;
  try {
    const ids = rows.map((r) => r.orderId);
    const r = await raceTimeout(upsertOrdersById(shop, ids), deadline.remaining());
    if (r.ok) {
      await db.dirtyOrder.deleteMany({ where: { shop, orderId: { in: ids }, markedAt: { lte: startedAt } } });
      return "DONE";
    }
    if (r.timedOut) {
      abandoned = true; // lease expires on its own
      return "TIMEOUT";
    }
    console.error(`[sweep] dirty orders failed for ${shop}`, r.error);
    return "ERROR";
  } finally {
    if (!abandoned) await releaseLease(shop, token).catch(() => {});
  }
}

/* ------------------------------------------------------------------ */
/* customers/redact                                                    */
/* ------------------------------------------------------------------ */

export async function queueRedactions(shop: string, orderIds: string[]) {
  for (const orderId of orderIds) {
    await db.pendingRedaction.upsert({
      where: { shop_orderId: { shop, orderId } },
      create: { shop, orderId },
      update: {},
    });
  }
}

/** Inline attempt from the webhook. Throws (so the guard queues it) when the sheet is busy. */
export async function redactNow(shop: string, orderIds: string[]) {
  const r = await redactOrdersInSheet(shop, orderIds);
  if (r === "LOCKED") throw new Error("Sheet is busy; redaction queued");
}

/** Scheduled sweep: apply queued redactions. */
export async function processPendingRedactions(deadline: Deadline) {
  const rows = await db.pendingRedaction.findMany({ orderBy: { createdAt: "asc" }, take: 500 });
  const byShop = new Map<string, string[]>();
  for (const r of rows) byShop.set(r.shop, [...(byShop.get(r.shop) ?? []), r.orderId]);
  let done = 0;
  for (const [shop, ids] of byShop) {
    if (!deadline.hasTimeFor(3000)) break;
    const r = await raceTimeout(redactOrdersInSheet(shop, ids), deadline.remaining());
    if (r.ok && r.value === "DONE") {
      await db.pendingRedaction.deleteMany({ where: { shop, orderId: { in: ids } } });
      done += ids.length;
    } else {
      if (!r.ok && !r.timedOut) console.error(`[sweep] redaction failed for ${shop}`, r.error);
      await db.pendingRedaction.updateMany({ where: { shop, orderId: { in: ids } }, data: { attempts: { increment: 1 } } });
    }
  }
  return done;
}
