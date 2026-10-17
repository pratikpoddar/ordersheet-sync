/**
 * Pure building blocks for running sync work inside serverless time limits.
 * No database or network here, so everything is unit-tested (tests/jobs.test.ts).
 *
 * Netlify limits this is designed around: synchronous functions 60s, scheduled functions 30s,
 * no memory between invocations. Every unit of work therefore (1) checks a deadline before
 * starting the next page, (2) persists its cursor after every page, and (3) is idempotent,
 * so a chunk that is killed mid-page is simply replayed by the next invocation.
 */

import { buildOrderSearchQuery, type StatusFilters } from "./filters";

export const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Wall-clock budget for one invocation. */
export class Deadline {
  readonly endsAt: number;
  constructor(
    budgetMs: number,
    private now: () => number = Date.now,
  ) {
    this.endsAt = now() + Math.max(0, budgetMs);
  }
  remaining() {
    return Math.max(0, this.endsAt - this.now());
  }
  hasTimeFor(ms: number) {
    return this.remaining() >= ms;
  }
  /** A child deadline that ends at most `maxMs` from now and never after this one. */
  slice(maxMs: number) {
    return new Deadline(Math.min(maxMs, this.remaining()), this.now);
  }
}

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

export type Raced<T> = { ok: true; value: T } | { ok: false; timedOut: true } | { ok: false; timedOut: false; error: unknown };

/** Races a promise against a timer. The promise is NOT cancelled; callers decide what to do with it. */
export async function raceTimeout<T>(p: Promise<T>, ms: number): Promise<Raced<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Raced<T>>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true }), Math.max(0, ms));
  });
  try {
    return await Promise.race([
      p.then(
        (value): Raced<T> => ({ ok: true, value }),
        (error): Raced<T> => ({ ok: false, timedOut: false, error }),
      ),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/* Chunked, resumable paging                                           */
/* ------------------------------------------------------------------ */

export interface PageResult<T> {
  items: T[];
  endCursor: string | null;
  hasNextPage: boolean;
}

export interface JobProgress {
  cursor: string | null;
  pages: number;
  rowsWritten: number;
}

export interface ChunkPorts<T> {
  /** Fetch the page that follows `cursor` (null = first page). */
  fetchPage(cursor: string | null): Promise<PageResult<T>>;
  /** Write one page to the sheet; returns rows written. Must be idempotent (upsert by order id). */
  writePage(items: T[]): Promise<number>;
  /** Persist progress. Return false when the job was replaced/cancelled, which stops the chunk. */
  saveProgress(p: JobProgress): Promise<boolean>;
}

export interface ChunkOptions {
  /** Don't start a page unless at least this much time is left (covers one slow page + the final save). */
  minPageMs?: number;
  /** Safety factor applied to the slowest page seen so far in this chunk. */
  slowPageFactor?: number;
  now?: () => number;
}

export type ChunkStatus = "DONE" | "PAUSED" | "CANCELLED";

export interface ChunkResult extends JobProgress {
  status: ChunkStatus;
  pagesThisChunk: number;
  rowsThisChunk: number;
}

/**
 * Processes pages until the job is finished or the deadline is near. Progress is saved
 * after EVERY page, so a hard kill loses at most one page of work, which is then replayed
 * (safe, because writes are upserts keyed by order id).
 */
export async function runPagedChunk<T>(
  ports: ChunkPorts<T>,
  start: JobProgress,
  deadline: Deadline,
  opts: ChunkOptions = {},
): Promise<ChunkResult> {
  const now = opts.now ?? Date.now;
  const minPageMs = opts.minPageMs ?? 4000;
  const factor = opts.slowPageFactor ?? 1.5;
  let { cursor, pages, rowsWritten } = start;
  let pagesThisChunk = 0;
  let rowsThisChunk = 0;
  let slowest = 0;

  for (;;) {
    const needed = Math.max(minPageMs, slowest * factor);
    if (!deadline.hasTimeFor(needed)) {
      return { status: "PAUSED", cursor, pages, rowsWritten, pagesThisChunk, rowsThisChunk };
    }
    const t0 = now();
    const page = await ports.fetchPage(cursor);
    const written = page.items.length ? await ports.writePage(page.items) : 0;
    pages += 1;
    pagesThisChunk += 1;
    rowsWritten += written;
    rowsThisChunk += written;
    const nextCursor = page.hasNextPage ? page.endCursor : null;
    if (page.hasNextPage && !page.endCursor) throw new Error("Shopify returned hasNextPage without a cursor");
    cursor = nextCursor;
    slowest = Math.max(slowest, now() - t0);

    const stillCurrent = await ports.saveProgress({ cursor, pages, rowsWritten });
    if (!stillCurrent) return { status: "CANCELLED", cursor, pages, rowsWritten, pagesThisChunk, rowsThisChunk };
    if (!page.hasNextPage) return { status: "DONE", cursor, pages, rowsWritten, pagesThisChunk, rowsThisChunk };
  }
}

/* ------------------------------------------------------------------ */
/* Retry policy for a job whose chunk threw                            */
/* ------------------------------------------------------------------ */

export const MAX_JOB_ATTEMPTS = 3;

/** A job keeps its cursor and is retried by the next invocation unless the error is permanent or attempts ran out. */
export function shouldRetryJob(attemptsSoFar: number, permanent: boolean): boolean {
  return !permanent && attemptsSoFar + 1 < MAX_JOB_ATTEMPTS;
}

/* ------------------------------------------------------------------ */
/* Inline webhook work with a timeout guard                            */
/* ------------------------------------------------------------------ */

export type InlineOutcome = "DONE" | "TIMEOUT" | "ERROR";

/**
 * Runs `work` inline but never lets it hold the HTTP response past `timeoutMs`
 * (Shopify expects a webhook response within 5s). On error or timeout, `onDefer` records the
 * order as dirty so the scheduled function picks it up. On timeout, if the platform gives us
 * `waitUntil` (Netlify does), the in-flight work is allowed to finish after the response.
 * Never throws.
 */
export async function runInlineWithGuard(
  work: () => Promise<unknown>,
  opts: {
    timeoutMs: number;
    onDefer: (reason: "timeout" | "error", error?: unknown) => Promise<void>;
    waitUntil?: (p: Promise<unknown>) => void;
    /** Max extra time the in-flight work may keep the function alive via waitUntil. */
    tailMs?: number;
  },
): Promise<InlineOutcome> {
  let p: Promise<unknown>;
  try {
    p = Promise.resolve(work());
  } catch (error) {
    p = Promise.reject(error);
  }
  const r = await raceTimeout(p, opts.timeoutMs);
  if (r.ok) return "DONE";
  const reason = r.timedOut ? "timeout" : "error";
  try {
    await opts.onDefer(reason, r.timedOut ? undefined : r.error);
  } catch (e) {
    console.error("[webhook] could not record deferred order", e);
  }
  if (r.timedOut && opts.waitUntil) opts.waitUntil(raceTimeout(p, opts.tailMs ?? 20_000));
  return r.timedOut ? "TIMEOUT" : "ERROR";
}

/* ------------------------------------------------------------------ */
/* Scheduler planning                                                  */
/* ------------------------------------------------------------------ */

export interface SweepShopRow {
  shop: string;
  hasJob: boolean;
  jobUpdatedAt: Date | null;
  reconcileDue: boolean;
}

/**
 * Order of work for one scheduled invocation:
 *  - continue: shops with an active job, least recently advanced first (fair round-robin)
 *  - start: shops whose reconciliation is due and that have no job yet
 */
export function planSweep(rows: SweepShopRow[]) {
  const cont = rows
    .filter((r) => r.hasJob)
    .sort((a, b) => (a.jobUpdatedAt?.getTime() ?? 0) - (b.jobUpdatedAt?.getTime() ?? 0))
    .map((r) => r.shop);
  const start = rows.filter((r) => !r.hasJob && r.reconcileDue).map((r) => r.shop);
  return { continue: cont, start };
}

/* ------------------------------------------------------------------ */
/* Job parameters (fixed in the PREPARE phase, stored as JSON)         */
/* ------------------------------------------------------------------ */

/** Overlap for incremental syncs so clock skew / late writes are never missed. */
export const INCREMENTAL_OVERLAP_MS = 2 * 60 * 60_000;

export interface JobParams {
  full: boolean;
  searchQuery: string;
  sortKey: "CREATED_AT" | "UPDATED_AT";
  createdFrom: string | null;
  createdTo: string | null;
  timezone: string;
  note: string;
}

export function buildJobParams(
  lastSuccessAt: Date | null,
  eff: { filters: StatusFilters; backfillFrom: string | null; backfillTo: string | null },
  needsFull: boolean,
  timezone: string,
): JobParams {
  const createdFrom = eff.backfillFrom;
  const createdTo = needsFull ? eff.backfillTo : null;
  const updatedSince =
    !needsFull && lastSuccessAt ? new Date(lastSuccessAt.getTime() - INCREMENTAL_OVERLAP_MS).toISOString() : null;
  // Full: status filters go into the search. Incremental: fetch everything updated and apply the
  // filters locally, so an order that stops matching is removed from the sheet.
  const searchQuery = needsFull
    ? buildOrderSearchQuery({ createdFrom, createdTo, filters: eff.filters })
    : buildOrderSearchQuery({
        createdFrom,
        updatedSince,
        filters: { financial: [], fulfillment: [], includeTest: true, includeCancelled: true },
      });
  return {
    full: needsFull,
    searchQuery,
    sortKey: needsFull ? "CREATED_AT" : "UPDATED_AT",
    createdFrom,
    createdTo,
    timezone,
    note: needsFull ? "Full sync" : "Incremental sync",
  };
}
