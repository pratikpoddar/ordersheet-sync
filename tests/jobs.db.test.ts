/**
 * Integration test of the serverless job runner against a real Postgres database
 * (Shopify and Google are faked in memory). Opt-in: runs only when TEST_DATABASE_URL is set,
 * e.g. a local/throwaway Postgres or Supabase branch with the migrations applied:
 *
 *   DATABASE_URL=$TEST_DATABASE_URL DIRECT_URL=$TEST_DATABASE_URL npx prisma migrate deploy
 *   TEST_DATABASE_URL=postgresql://... npm run test:db
 *
 * The test wipes every table, so never point it at production.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fromGraphQL, type NormalizedOrder } from "../app/lib/normalize";
import { graphqlOrder } from "./fixtures";

const TEST_DB = process.env.TEST_DATABASE_URL;
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;

const fake = vi.hoisted(() => {
  const state = {
    orders: [] as NormalizedOrder[],
    pageDelayMs: 0,
    failNextPages: 0,
    sheets: new Map<string, unknown[][]>(),
    created: 0,
  };
  return state;
});

vi.mock("../app/services/shopifyOrders.server", () => ({
  adminFor: async () => ({}),
  fetchShopTimezone: async () => "UTC",
  fetchActivePlanNames: async () => ["OrderSheet Sync Pro"],
  fetchOrderById: async (_g: unknown, id: string) => fake.orders.find((o) => o.id === id) ?? null,
  fetchOrdersPage: async (_g: unknown, _q: string, opts: { after: string | null }) => {
    if (fake.pageDelayMs) await new Promise((r) => setTimeout(r, fake.pageDelayMs));
    if (fake.failNextPages > 0) {
      fake.failNextPages--;
      throw new Error("Shopify 502");
    }
    const from = opts.after === null ? 0 : Number(opts.after) + 1;
    const items = fake.orders.slice(from, from + 40);
    const last = from + items.length - 1;
    return { items, endCursor: items.length ? String(last) : opts.after, hasNextPage: last < fake.orders.length - 1 };
  },
}));

vi.mock("../app/services/google.server", () => {
  class GoogleAuthError extends Error {}
  const rows = (id: string) => fake.sheets.get(id)!;
  return {
    GoogleAuthError,
    a1: (title: string, range: string) => `'${title}'!${range}`,
    revokeAndDelete: async () => {},
    spreadsheetExists: async (_s: string, id: string) => fake.sheets.has(id),
    createSpreadsheet: async () => {
      const id = `sheet-${++fake.created}`;
      fake.sheets.set(id, []);
      return { spreadsheetId: id, spreadsheetUrl: `https://docs.google.com/${id}`, sheetGid: 0 };
    },
    clearSheet: async (_s: string, id: string) => void fake.sheets.set(id, []),
    writeCells: async (_s: string, id: string, range: string, values: unknown[][]) => {
      const m = /!([A-Z]+)(\d+)$/.exec(range)!;
      const r = rows(id);
      const rn = Number(m[2]);
      if (m[1] === "A") r[rn - 1] = values[0];
      else (r[rn - 1] ??= [])[m[1].charCodeAt(0) - 65] = values[0][0];
    },
    readIdColumn: async (_s: string, id: string) => rows(id).map((r) => r?.[0] ?? ""),
    getGridRowCount: async () => 100_000,
    ensureGridRows: async () => {},
    batchWriteRows: async (_s: string, id: string, _t: string, writes: { rowNumber: number; values: unknown[] }[]) => {
      const r = rows(id);
      for (const w of writes) r[w.rowNumber - 1] = w.values;
    },
    deleteRows: async (_s: string, id: string, _g: number, desc: number[]) => {
      const r = rows(id);
      for (const rn of desc) r.splice(rn - 1, 1);
    },
  };
});

const SHOP = "demo.myshopify.com";
const order = (i: number, updated = "2026-10-01T10:00:00Z") =>
  fromGraphQL({
    ...graphqlOrder,
    id: `gid://shopify/Order/${7000 + i}`,
    legacyResourceId: String(7000 + i),
    name: `#${1000 + i}`,
    createdAt: new Date(Date.UTC(2026, 8, 1) + i * 60_000).toISOString(),
    updatedAt: updated,
  });

describe.skipIf(!TEST_DB)("serverless job runner (Postgres)", async () => {
  const db = (await import("../app/db.server")).default;
  const jobs = await import("../app/services/jobs.server");
  const hooks = await import("../app/services/webhookSync.server");
  const { runScheduledSweep } = await import("../app/services/scheduler.server");

  const sheetIds = async () => {
    const cfg = await db.syncConfig.findUniqueOrThrow({ where: { shop: SHOP } });
    return fake.sheets.get(cfg.spreadsheetId!)!.slice(1).map((r) => String(r?.[0] ?? "").replace(/^'/, ""));
  };

  beforeEach(async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const t of ["syncLog", "dirtyOrder", "pendingRedaction", "syncConfig", "googleConnection", "shop", "session"] as const) {
      await (db[t] as any).deleteMany({});
    }
    fake.orders = Array.from({ length: 400 }, (_, i) => order(i));
    fake.pageDelayMs = 0;
    fake.failNextPages = 0;
    fake.sheets.clear();
    await db.shop.create({ data: { shop: SHOP, plan: "PRO", planCheckedAt: new Date() } });
    await db.googleConnection.create({ data: { shop: SHOP, encryptedRefreshToken: "x", scope: "drive.file" } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("runs a backfill across several bounded chunks, persisting the cursor in the DB", async () => {
    fake.pageDelayMs = 250;
    expect((await jobs.startJob(SHOP, "BACKFILL")).status).toBe("STARTED");
    expect((await jobs.startJob(SHOP, "MANUAL")).status).toBe("ALREADY_RUNNING");

    const r1 = await jobs.runJobChunk(SHOP, 5_000); // ~4 pages, then pauses
    expect(r1.status).toBe("PAUSED");
    const mid = await db.syncConfig.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(mid.jobPhase).toBe("PAGES");
    expect(mid.jobCursor).not.toBeNull();
    expect(mid.jobPages).toBeGreaterThan(0);
    expect(mid.jobPages).toBeLessThan(10);
    expect(jobs.jobStatusFrom(mid)).toMatchObject({ kind: "BACKFILL", full: true });

    let r = r1;
    for (let i = 0; i < 20 && r.status !== "DONE"; i++) r = await jobs.runJobChunk(SHOP, 5_000);
    expect(r.status).toBe("DONE");

    const cfg = await db.syncConfig.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(cfg.jobId).toBeNull();
    expect(cfg.syncing).toBe(false);
    expect(cfg.lastSuccessAt).not.toBeNull();
    expect(cfg.rowCount).toBe(400);
    expect(cfg.lockedUntil).toBeNull();
    expect(await sheetIds()).toEqual(fake.orders.map((o) => o.id));
    const log = await db.syncLog.findFirstOrThrow({ where: { shop: SHOP, kind: "BACKFILL" } });
    expect(log).toMatchObject({ status: "SUCCESS", rowsWritten: 400 });
  }, 60_000);

  it("lets only one invocation work a shop at a time (DB lease)", async () => {
    fake.pageDelayMs = 200;
    await jobs.startJob(SHOP, "BACKFILL");
    const [a, b] = await Promise.all([jobs.runJobChunk(SHOP, 4_500), jobs.runJobChunk(SHOP, 4_500)]);
    expect([a.status, b.status].sort()).toEqual(["LOCKED", "PAUSED"]);
  }, 30_000);

  it("a replaced job stops writing (Rebuild clicked mid-backfill)", async () => {
    await jobs.startJob(SHOP, "BACKFILL");
    fake.pageDelayMs = 200;
    const running = jobs.runJobChunk(SHOP, 6_000);
    await new Promise((r) => setTimeout(r, 900));
    expect((await jobs.startJob(SHOP, "REBUILD", { rebuild: true, replace: true })).status).toBe("STARTED");
    expect((await running).status).toBe("CANCELLED");
    fake.pageDelayMs = 0;
    expect((await jobs.runJobChunk(SHOP, 20_000)).status).toBe("DONE");
    expect(await sheetIds()).toEqual(fake.orders.map((o) => o.id));
    const logs = await db.syncLog.findMany({ where: { shop: SHOP }, orderBy: { id: "asc" } });
    expect(logs.map((l) => `${l.kind}:${l.status}`)).toEqual(["BACKFILL:SKIPPED", "REBUILD:SUCCESS"]);
  }, 30_000);

  it("keeps the cursor and retries after a transient error, then fails after the limit", async () => {
    await jobs.startJob(SHOP, "BACKFILL");
    fake.failNextPages = 1;
    expect((await jobs.runJobChunk(SHOP, 20_000)).status).toBe("RETRY");
    expect((await jobs.runJobChunk(SHOP, 20_000)).status).toBe("DONE");

    await jobs.startJob(SHOP, "MANUAL");
    fake.failNextPages = 10;
    expect((await jobs.runJobChunk(SHOP, 20_000)).status).toBe("RETRY");
    expect((await jobs.runJobChunk(SHOP, 20_000)).status).toBe("RETRY");
    expect((await jobs.runJobChunk(SHOP, 20_000)).status).toBe("FAILED");
    const cfg = await db.syncConfig.findUniqueOrThrow({ where: { shop: SHOP } });
    expect(cfg.jobId).toBeNull();
    expect(cfg.lastError).toContain("Shopify 502");
  }, 30_000);

  it("webhook: upserts inline when idle, defers to DirtyOrder while a job runs, sweep writes it", async () => {
    await jobs.startJob(SHOP, "BACKFILL");
    await jobs.runJobChunk(SHOP, 20_000);

    fake.orders[3] = { ...order(3, "2026-10-17T10:00:00Z"), name: "#EDITED" };
    expect(await hooks.syncOrderFromWebhook(SHOP, fake.orders[3].id)).toBe("SYNCED");
    expect(await sheetIds()).toHaveLength(400);

    // A job is running: the webhook only marks the order dirty.
    fake.orders.push(order(400));
    await jobs.startJob(SHOP, "MANUAL");
    expect(await hooks.syncOrderFromWebhook(SHOP, fake.orders[400].id)).toBe("DEFERRED");
    expect(await db.dirtyOrder.count({ where: { shop: SHOP } })).toBe(1);
    // Abandon that job so only the dirty path can write the new order.
    await db.syncConfig.update({ where: { shop: SHOP }, data: { jobId: null, jobKind: null, syncing: false } });

    const summary = await runScheduledSweep({ budgetMs: 20_000 });
    expect(summary.dirtyShops).toBe(1);
    expect(await db.dirtyOrder.count()).toBe(0);
    expect((await sheetIds()).at(-1)).toBe(fake.orders[400].id);
    expect(await sheetIds()).toHaveLength(401);
  }, 30_000);

  it("scheduled sweep starts due reconciles and stays inside its budget", async () => {
    await jobs.startJob(SHOP, "BACKFILL");
    await jobs.runJobChunk(SHOP, 20_000);
    await db.syncConfig.update({ where: { shop: SHOP }, data: { lastReconciledAt: new Date(Date.now() - 2 * 3600_000) } });
    fake.pageDelayMs = 300;
    const t0 = Date.now();
    const summary = await runScheduledSweep({ budgetMs: 10_000 });
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(summary.started).toEqual([SHOP]);
    expect(summary.chunks[0]?.shop).toBe(SHOP);
  }, 30_000);

  it("Free shops ignore order webhooks", async () => {
    await db.shop.update({ where: { shop: SHOP }, data: { plan: "FREE" } });
    expect(await hooks.syncOrderFromWebhook(SHOP, "7001")).toBe("IGNORED");
  });
});
