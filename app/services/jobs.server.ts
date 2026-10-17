import { randomUUID } from "node:crypto";
import db from "../db.server";
import { config } from "../config.server";
import { buildJobParams, Deadline, raceTimeout, runPagedChunk, shouldRetryJob, type JobParams, type JobProgress } from "../lib/jobs";
import { GoogleAuthError } from "./google.server";
import { adminFor, fetchOrdersPage, fetchShopTimezone } from "./shopifyOrders.server";
import { effectiveSettings, getOrCreateConfig } from "./shopData.server";
import {
  acquireLease,
  finishLog,
  friendlyError,
  prepareSheet,
  releaseLease,
  SheetSession,
  splitByFilters,
  startLog,
  type SyncKind,
} from "./sync.server";

/**
 * Resumable sync jobs for serverless hosting.
 *
 * A job (full backfill/rebuild or incremental reconcile) is recorded on SyncConfig and advanced
 * in bounded chunks by whoever gets there first: the "Sync now"/"Rebuild" action, the dashboard
 * poll, the Google OAuth callback or the 15-minute scheduled function. Each chunk:
 *   1. takes the shop's DB lease (one writer per sheet),
 *   2. PREPARE phase (first chunk only): creates/clears the sheet and fixes the search query,
 *   3. PAGES phase: fetches 40 orders per page from the cursor, upserts them, saves the cursor,
 *   4. stops before its time budget runs out; the next chunk continues from the saved cursor.
 * Writes are upserts keyed by order id, so replaying a page after a crash never duplicates rows.
 */

export type JobKind = Exclude<SyncKind, "WEBHOOK">;

/** Lease = chunk budget + this, so a killed function frees the shop shortly after its limit. */
const LEASE_GRACE_MS = 30_000;
/** Hard stop: a chunk that overruns its budget by this much is abandoned (progress is already saved). */
const DEFAULT_HARD_GRACE_MS = 8_000;

export class PermanentJobError extends Error {}


const CLEAR_JOB = {
  jobId: null,
  jobKind: null,
  jobPhase: null,
  jobCursor: null,
  jobParams: null,
  jobForceRebuild: false,
  jobLogId: null,
  jobStartedAt: null,
  jobUpdatedAt: null,
  jobPages: 0,
  jobRowsWritten: 0,
  jobAttempts: 0,
  syncing: false,
} as const;

export type StartResult = { status: "STARTED" | "ALREADY_RUNNING" | "SKIPPED"; reason?: string };

/**
 * Records a new job. Does no API work, so it is safe to call from webhooks.
 * `replace` supersedes a running job (settings changed, plan changed, explicit rebuild).
 */
export async function startJob(
  shop: string,
  kind: JobKind,
  opts: { rebuild?: boolean; replace?: boolean } = {},
): Promise<StartResult> {
  const conn = await db.googleConnection.findUnique({ where: { shop } });
  if (!conn) return { status: "SKIPPED", reason: "Google not connected" };
  const cfg = await getOrCreateConfig(shop);
  if (cfg.jobId && !opts.replace) return { status: "ALREADY_RUNNING", reason: "A sync is already running" };

  const log = await startLog(shop, kind, "Queued");
  const now = new Date();
  // Compare-and-set on the previous jobId, so two concurrent starts can't both win.
  const res = await db.syncConfig.updateMany({
    where: { shop, jobId: cfg.jobId },
    data: {
      ...CLEAR_JOB,
      jobId: randomUUID(),
      jobKind: kind,
      jobPhase: "PREPARE",
      jobForceRebuild: Boolean(opts.rebuild),
      jobLogId: log.id,
      jobStartedAt: now,
      jobUpdatedAt: now,
      syncing: true,
    },
  });
  if (res.count === 0) {
    await finishLog(log.id, shop, "SKIPPED", 0, "Another sync started at the same time").catch(() => {});
    return { status: "ALREADY_RUNNING", reason: "A sync is already running" };
  }
  if (cfg.jobId && cfg.jobLogId) {
    await finishLog(cfg.jobLogId, shop, "SKIPPED", cfg.jobRowsWritten, `Superseded by ${kind.toLowerCase()}`).catch(() => {});
  }
  return { status: "STARTED" };
}

export type ChunkOutcome =
  | { status: "IDLE" | "LOCKED" | "CANCELLED" }
  | { status: "DONE" | "PAUSED"; progress?: JobProgress }
  | { status: "RETRY" | "FAILED"; message: string };

/**
 * Advances the shop's job for at most `budgetMs`. Safe to call from anywhere, any number
 * of times: without a job it returns IDLE, and with another invocation working it returns LOCKED.
 */
export async function runJobChunk(
  shop: string,
  budgetMs: number,
  opts: { hardGraceMs?: number } = {},
): Promise<ChunkOutcome> {
  const deadline = new Deadline(budgetMs);
  const first = await db.syncConfig.findUnique({ where: { shop } });
  if (!first?.jobId) return { status: "IDLE" };
  const jobId = first.jobId;

  const token = await acquireLease(shop, budgetMs + LEASE_GRACE_MS);
  if (!token) return { status: "LOCKED" };
  let abandoned = false;
  try {
    const r = await raceTimeout(chunkBody(shop, jobId, deadline), deadline.remaining() + (opts.hardGraceMs ?? DEFAULT_HARD_GRACE_MS));
    if (r.ok) return r.value;
    if (r.timedOut) {
      // Progress up to the last finished page is saved. Keep the lease until it expires so the
      // still-running page can't race a new chunk; the next invocation resumes from the cursor.
      abandoned = true;
      console.warn(`[jobs] chunk for ${shop} overran its budget; resuming next invocation`);
      return { status: "PAUSED" };
    }
    return await handleFailure(shop, jobId, r.error);
  } finally {
    if (!abandoned) await releaseLease(shop, token).catch((e) => console.error("[jobs] lease release failed", e));
  }
}

async function chunkBody(shop: string, jobId: string, deadline: Deadline): Promise<ChunkOutcome> {
  const cfg = await db.syncConfig.findUnique({ where: { shop } });
  if (!cfg || cfg.jobId !== jobId) return { status: "CANCELLED" };
  if (!(await db.googleConnection.findUnique({ where: { shop } }))) throw new PermanentJobError("Google not connected");

  const graphql = await adminFor(shop);
  let params: JobParams;
  let session: SheetSession;
  let start: JobProgress;
  let eff = await effectiveSettings(shop);

  if (cfg.jobPhase !== "PAGES" || !cfg.jobParams || !cfg.spreadsheetId || cfg.sheetGid === null) {
    // PREPARE: runs once per job (again only if it crashed before finishing).
    const timezone = await fetchShopTimezone(graphql);
    await db.shop.updateMany({ where: { shop }, data: { timezone } });
    const prep = await prepareSheet(shop, cfg.jobForceRebuild);
    eff = prep.eff;
    session = prep.session;
    params = buildJobParams(prep.cfg.lastSuccessAt, eff, prep.needsFull, timezone);
    start = { cursor: null, pages: 0, rowsWritten: 0 };
    const saved = await db.syncConfig.updateMany({
      where: { shop, jobId },
      data: {
        jobPhase: "PAGES",
        jobParams: JSON.stringify(params),
        jobCursor: null,
        jobPages: 0,
        jobRowsWritten: 0,
        jobForceRebuild: false,
        jobUpdatedAt: new Date(),
        rowCount: session.rowCount,
      },
    });
    if (!saved.count) return { status: "CANCELLED" };
    if (cfg.jobLogId) {
      await db.syncLog.updateMany({ where: { id: cfg.jobLogId }, data: { message: params.full ? "Full sync in progress" : "Incremental sync in progress" } });
    }
  } else {
    params = JSON.parse(cfg.jobParams) as JobParams;
    session = new SheetSession(shop, cfg.spreadsheetId, cfg.sheetTitle, cfg.sheetGid);
    await session.load();
    start = { cursor: cfg.jobCursor, pages: cfg.jobPages, rowsWritten: cfg.jobRowsWritten };
  }

  const includeProtected = config.protectedCustomerData();
  const window = { createdFrom: params.createdFrom, createdTo: params.createdTo };
  const result = await runPagedChunk(
    {
      fetchPage: (cursor) => fetchOrdersPage(graphql, params.searchQuery, { after: cursor, includeProtected, sortKey: params.sortKey }),
      writePage: async (orders) => {
        const before = session.written;
        const { writes, removes } = splitByFilters(orders, eff.filters, window, eff.columns, params.timezone);
        await session.upsert(writes, removes);
        return session.written - before;
      },
      saveProgress: async (p) => {
        const res = await db.syncConfig.updateMany({
          where: { shop, jobId },
          data: {
            jobCursor: p.cursor,
            jobPages: p.pages,
            jobRowsWritten: p.rowsWritten,
            jobAttempts: 0,
            jobUpdatedAt: new Date(),
            rowCount: session.rowCount,
          },
        });
        return res.count === 1;
      },
    },
    start,
    deadline,
  );

  if (result.status === "CANCELLED") return { status: "CANCELLED" };
  const progress = { cursor: result.cursor, pages: result.pages, rowsWritten: result.rowsWritten };

  if (result.status === "PAUSED") {
    if (cfg.jobLogId) {
      await db.syncLog.updateMany({
        where: { id: cfg.jobLogId },
        data: { rowsWritten: result.rowsWritten, message: `${params.full ? "Full" : "Incremental"} sync in progress: ${result.pages} page(s), ${result.rowsWritten} row(s) written` },
      });
    }
    return { status: "PAUSED", progress };
  }

  // DONE
  const startedAt = cfg.jobStartedAt ?? new Date();
  const fin = await db.syncConfig.updateMany({
    where: { shop, jobId },
    data: {
      ...CLEAR_JOB,
      lastSuccessAt: startedAt,
      lastReconciledAt: startedAt,
      rowCount: session.rowCount,
      lastError: null,
      lastErrorAt: null,
    },
  });
  if (!fin.count) return { status: "CANCELLED" };
  // Every order marked dirty before this job started was re-read by it.
  await db.dirtyOrder.deleteMany({ where: { shop, markedAt: { lte: startedAt } } });
  if (cfg.jobLogId) {
    await finishLog(cfg.jobLogId, shop, "SUCCESS", result.rowsWritten, [params.note, ...eff.clamped].join(". ")).catch(() => {});
  }
  return { status: "DONE", progress };
}

async function handleFailure(shop: string, jobId: string, err: unknown): Promise<ChunkOutcome> {
  const cfg = await db.syncConfig.findUnique({ where: { shop } });
  if (!cfg || cfg.jobId !== jobId) return { status: "CANCELLED" };
  const message = friendlyError(err);
  console.error(`[jobs] ${cfg.jobKind} chunk failed for ${shop}`, err);
  const permanent = err instanceof GoogleAuthError || err instanceof PermanentJobError;
  if (shouldRetryJob(cfg.jobAttempts, permanent)) {
    await db.syncConfig.updateMany({ where: { shop, jobId }, data: { jobAttempts: { increment: 1 }, jobUpdatedAt: new Date() } });
    if (cfg.jobLogId) {
      await db.syncLog.updateMany({ where: { id: cfg.jobLogId }, data: { message: `Retrying after error: ${message}` } });
    }
    return { status: "RETRY", message };
  }
  await db.syncConfig.updateMany({
    where: { shop, jobId },
    data: { ...CLEAR_JOB, lastError: message, lastErrorAt: new Date() },
  });
  if (cfg.jobLogId) await finishLog(cfg.jobLogId, shop, "ERROR", cfg.jobRowsWritten, message).catch(() => {});
  return { status: "FAILED", message };
}

/** Dashboard view of the job, read straight from the DB. */
export function jobStatusFrom(cfg: {
  jobId: string | null;
  jobKind: string | null;
  jobPhase: string | null;
  jobPages: number;
  jobRowsWritten: number;
  jobStartedAt: Date | null;
  jobUpdatedAt: Date | null;
  jobAttempts: number;
  jobParams: string | null;
}) {
  if (!cfg.jobId) return null;
  let full: boolean | null = null;
  try {
    full = cfg.jobParams ? Boolean(JSON.parse(cfg.jobParams).full) : null;
  } catch {}
  return {
    kind: cfg.jobKind ?? "SYNC",
    phase: cfg.jobPhase ?? "PREPARE",
    full,
    pages: cfg.jobPages,
    rowsWritten: cfg.jobRowsWritten,
    startedAt: cfg.jobStartedAt?.toISOString() ?? null,
    updatedAt: cfg.jobUpdatedAt?.toISOString() ?? null,
    attempts: cfg.jobAttempts,
  };
}
