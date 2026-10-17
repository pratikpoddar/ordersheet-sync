import { describe, expect, it, vi } from "vitest";
import { EMPTY_FILTERS } from "../app/lib/filters";
import {
  buildJobParams,
  Deadline,
  INCREMENTAL_OVERLAP_MS,
  MAX_JOB_ATTEMPTS,
  planSweep,
  raceTimeout,
  runInlineWithGuard,
  runPagedChunk,
  shouldRetryJob,
  type ChunkPorts,
  type JobProgress,
  type PageResult,
} from "../app/lib/jobs";
import { normalizeIdCell, planUpsert } from "../app/lib/upsert";

/* ------------------------------------------------------------------ */
/* Test doubles: a fake clock, a fake Shopify connection, a fake sheet */
/* ------------------------------------------------------------------ */

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

interface FakeOrder {
  id: string;
  v: string;
}

/** Shopify-like cursor pagination over a fixed list. Cursor = index of the last item returned. */
function fakeShopify(orders: FakeOrder[], pageSize = 40, clock?: ReturnType<typeof fakeClock>, msPerPage = 0) {
  const calls: (string | null)[] = [];
  return {
    calls,
    fetchPage: async (cursor: string | null): Promise<PageResult<FakeOrder>> => {
      calls.push(cursor);
      clock?.advance(msPerPage);
      const from = cursor === null ? 0 : Number(cursor) + 1;
      const items = orders.slice(from, from + pageSize);
      const last = from + items.length - 1;
      return { items, endCursor: items.length ? String(last) : cursor, hasNextPage: last < orders.length - 1 };
    },
  };
}

/** In-memory sheet that applies the real planUpsert, exactly like SheetSession does. */
function fakeSheet() {
  let rows: string[][] = [["Order ID", "Value"]];
  return {
    get rows() {
      return rows;
    },
    write(items: FakeOrder[]) {
      const plan = planUpsert(
        rows.map((r) => r[0]),
        items.map((o) => ({ id: o.id, values: [`'${o.id}`, o.v] })),
      );
      const next = rows.map((r) => [...r]);
      for (const w of [...plan.updates, ...plan.appends]) next[w.rowNumber - 1] = w.values as string[];
      for (const rn of plan.deletes) next.splice(rn - 1, 1);
      rows = next;
      return plan.updates.length + plan.appends.length;
    },
    ids() {
      return rows.slice(1).map((r) => normalizeIdCell(r[0]));
    },
  };
}

const orders = (n: number) => Array.from({ length: n }, (_, i) => ({ id: String(1000 + i), v: `v${i}` }));

/** Persisted job progress, like the SyncConfig.job* columns. */
function fakeStore(initial: JobProgress = { cursor: null, pages: 0, rowsWritten: 0 }) {
  const store = { progress: { ...initial }, saves: 0, current: true };
  return store;
}

function ports(shopify: ReturnType<typeof fakeShopify>, sheet: ReturnType<typeof fakeSheet>, store: ReturnType<typeof fakeStore>): ChunkPorts<FakeOrder> {
  return {
    fetchPage: shopify.fetchPage,
    writePage: async (items) => sheet.write(items),
    saveProgress: async (p) => {
      store.saves++;
      if (!store.current) return false;
      store.progress = { ...p };
      return true;
    },
  };
}

/* ------------------------------------------------------------------ */

describe("Deadline and raceTimeout", () => {
  it("tracks the remaining budget and slices never exceed the parent", () => {
    const c = fakeClock();
    const d = new Deadline(25_000, c.now);
    c.advance(10_000);
    expect(d.remaining()).toBe(15_000);
    expect(d.slice(30_000).remaining()).toBe(15_000);
    expect(d.slice(5_000).remaining()).toBe(5_000);
    c.advance(20_000);
    expect(d.remaining()).toBe(0);
    expect(d.hasTimeFor(1)).toBe(false);
  });

  it("returns the value, the error, or a timeout", async () => {
    expect(await raceTimeout(Promise.resolve(3), 50)).toEqual({ ok: true, value: 3 });
    const err = new Error("x");
    expect(await raceTimeout(Promise.reject(err), 50)).toEqual({ ok: false, timedOut: false, error: err });
    expect(await raceTimeout(new Promise(() => {}), 10)).toEqual({ ok: false, timedOut: true });
  });
});

describe("runPagedChunk (chunked, resumable job runner)", () => {
  it("finishes a small job in one chunk and reports DONE", async () => {
    const c = fakeClock();
    const shopify = fakeShopify(orders(90), 40, c, 1000);
    const sheet = fakeSheet();
    const store = fakeStore();
    const r = await runPagedChunk(ports(shopify, sheet, store), store.progress, new Deadline(25_000, c.now), { now: c.now });
    expect(r.status).toBe("DONE");
    expect(r.pages).toBe(3);
    expect(r.rowsWritten).toBe(90);
    expect(sheet.ids()).toHaveLength(90);
    expect(store.saves).toBe(3); // progress persisted after every page
  });

  it("stops before the deadline and a later invocation continues from the saved cursor", async () => {
    const c = fakeClock();
    const all = orders(1000); // 25 pages
    const shopify = fakeShopify(all, 40, c, 3000); // 3s per page (fetch + write)
    const sheet = fakeSheet();
    const store = fakeStore();

    const r1 = await runPagedChunk(ports(shopify, sheet, store), store.progress, new Deadline(25_000, c.now), { now: c.now });
    expect(r1.status).toBe("PAUSED");
    // 25s budget, 3s pages, stops while ≥ max(4s, 1.5×3s)=4.5s is left: pages end at 3,6,...,21 -> 7 pages
    expect(r1.pagesThisChunk).toBe(7);
    expect(c.now() - 1_000_000).toBeLessThanOrEqual(25_000);
    expect(store.progress.cursor).toBe(String(7 * 40 - 1));

    // Next invocations (e.g. the scheduled function every 15 min) pick up from the DB state.
    let runs = 1;
    let last = r1;
    while (last.status !== "DONE") {
      last = await runPagedChunk(ports(shopify, sheet, store), store.progress, new Deadline(25_000, c.now), { now: c.now });
      runs++;
      expect(runs).toBeLessThan(10);
    }
    expect(last.pages).toBe(25);
    expect(last.rowsWritten).toBe(1000);
    expect(sheet.ids()).toEqual(all.map((o) => o.id)); // every order exactly once, in order
    // Each page fetched exactly once across all invocations
    expect(new Set(shopify.calls.map(String)).size).toBe(shopify.calls.length);
  });

  it("replays a page after a hard kill without duplicating rows", async () => {
    const c = fakeClock();
    const all = orders(120);
    const shopify = fakeShopify(all, 40, c, 1000);
    const sheet = fakeSheet();
    const store = fakeStore();
    let kills = 1;
    const p = ports(shopify, sheet, store);
    const killing: ChunkPorts<FakeOrder> = {
      ...p,
      // Simulates the function being killed after the sheet write but before the cursor save.
      saveProgress: async (prog) => {
        if (prog.pages === 2 && kills-- > 0) throw new Error("killed");
        return p.saveProgress(prog);
      },
    };
    await expect(runPagedChunk(killing, store.progress, new Deadline(25_000, c.now), { now: c.now })).rejects.toThrow("killed");
    expect(store.progress.pages).toBe(1); // last saved state
    const r = await runPagedChunk(p, store.progress, new Deadline(25_000, c.now), { now: c.now });
    expect(r.status).toBe("DONE");
    expect(sheet.ids()).toEqual(all.map((o) => o.id)); // page 2 written twice, still 120 unique rows
  });

  it("does not start a page without enough time left", async () => {
    const c = fakeClock();
    const shopify = fakeShopify(orders(10), 40, c, 1000);
    const store = fakeStore();
    const r = await runPagedChunk(ports(shopify, fakeSheet(), store), store.progress, new Deadline(3_000, c.now), { now: c.now });
    expect(r.status).toBe("PAUSED");
    expect(r.pagesThisChunk).toBe(0);
    expect(shopify.calls).toEqual([]);
  });

  it("adapts to slow pages so it does not overrun the budget", async () => {
    const c = fakeClock();
    const shopify = fakeShopify(orders(400), 40, c, 9000); // 9s per page
    const store = fakeStore();
    const r = await runPagedChunk(ports(shopify, fakeSheet(), store), store.progress, new Deadline(25_000, c.now), { now: c.now });
    // after page 1 (9s) it needs 13.5s; 16s left -> page 2 (18s); 7s left < 13.5s -> pause
    expect(r.pagesThisChunk).toBe(2);
    expect(c.now() - 1_000_000).toBeLessThanOrEqual(25_000);
  });

  it("stops writing when the job was replaced (e.g. merchant clicked Rebuild)", async () => {
    const c = fakeClock();
    const shopify = fakeShopify(orders(400), 40, c, 1000);
    const store = fakeStore();
    store.current = false;
    const r = await runPagedChunk(ports(shopify, fakeSheet(), store), store.progress, new Deadline(25_000, c.now), { now: c.now });
    expect(r.status).toBe("CANCELLED");
    expect(r.pagesThisChunk).toBe(1);
  });

  it("handles an empty result set", async () => {
    const c = fakeClock();
    const store = fakeStore();
    const r = await runPagedChunk(ports(fakeShopify([], 40, c), fakeSheet(), store), store.progress, new Deadline(25_000, c.now), { now: c.now });
    expect(r).toMatchObject({ status: "DONE", pages: 1, rowsWritten: 0, cursor: null });
  });
});

describe("job retry policy", () => {
  it("retries transient errors up to the limit and never retries permanent ones", () => {
    expect(shouldRetryJob(0, false)).toBe(true);
    expect(shouldRetryJob(MAX_JOB_ATTEMPTS - 2, false)).toBe(true);
    expect(shouldRetryJob(MAX_JOB_ATTEMPTS - 1, false)).toBe(false);
    expect(shouldRetryJob(0, true)).toBe(false);
  });
});

describe("buildJobParams", () => {
  const eff = { filters: { ...EMPTY_FILTERS, financial: ["PAID"] }, backfillFrom: "2026-01-01", backfillTo: "2026-06-30" };

  it("full sync: created window + status filters in the search, oldest first", () => {
    const p = buildJobParams(null, eff as any, true, "Asia/Kolkata");
    expect(p).toMatchObject({ full: true, sortKey: "CREATED_AT", createdFrom: "2026-01-01", createdTo: "2026-06-30", timezone: "Asia/Kolkata" });
    expect(p.searchQuery).toContain("created_at:>=2026-01-01");
    expect(p.searchQuery).toContain("financial_status:PAID");
  });

  it("incremental: updated since last success minus overlap, filters applied locally", () => {
    const last = new Date("2026-10-17T10:00:00Z");
    const p = buildJobParams(last, eff as any, false, "UTC");
    expect(p).toMatchObject({ full: false, sortKey: "UPDATED_AT", createdTo: null });
    expect(p.searchQuery).toContain(`updated_at:>='${new Date(last.getTime() - INCREMENTAL_OVERLAP_MS).toISOString()}'`);
    expect(p.searchQuery).not.toContain("financial_status");
  });
});

describe("runInlineWithGuard (webhook timeout guard)", () => {
  it("returns DONE when the work finishes in time", async () => {
    const onDefer = vi.fn(async () => {});
    expect(await runInlineWithGuard(async () => "ok", { timeoutMs: 100, onDefer })).toBe("DONE");
    expect(onDefer).not.toHaveBeenCalled();
  });

  it("marks the order dirty on error and never throws", async () => {
    const onDefer = vi.fn(async () => {});
    const err = new Error("Google 503");
    expect(await runInlineWithGuard(async () => Promise.reject(err), { timeoutMs: 100, onDefer })).toBe("ERROR");
    expect(onDefer).toHaveBeenCalledWith("error", err);
    // synchronous throw inside work
    expect(await runInlineWithGuard(() => { throw err; }, { timeoutMs: 100, onDefer })).toBe("ERROR");
  });

  it("on timeout: marks dirty, answers anyway, and hands the in-flight work to waitUntil", async () => {
    const onDefer = vi.fn(async () => {});
    const waitUntil = vi.fn();
    const t0 = Date.now();
    const r = await runInlineWithGuard(() => new Promise(() => {}), { timeoutMs: 30, onDefer, waitUntil });
    expect(r).toBe("TIMEOUT");
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(onDefer).toHaveBeenCalledWith("timeout", undefined);
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("still resolves when recording the dirty order itself fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await runInlineWithGuard(async () => Promise.reject(new Error("x")), {
      timeoutMs: 50,
      onDefer: async () => {
        throw new Error("db down");
      },
    });
    expect(r).toBe("ERROR");
    spy.mockRestore();
  });
});

describe("planSweep", () => {
  it("continues running jobs oldest-progress first and starts due shops without a job", () => {
    const d = (m: number) => new Date(Date.UTC(2026, 9, 17, 10, m));
    const plan = planSweep([
      { shop: "a", hasJob: true, jobUpdatedAt: d(30), reconcileDue: true },
      { shop: "b", hasJob: true, jobUpdatedAt: d(5), reconcileDue: false },
      { shop: "c", hasJob: false, jobUpdatedAt: null, reconcileDue: true },
      { shop: "d", hasJob: false, jobUpdatedAt: null, reconcileDue: false },
    ]);
    expect(plan.continue).toEqual(["b", "a"]);
    expect(plan.start).toEqual(["c"]);
  });
});
