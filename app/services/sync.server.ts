import db from "../db.server";
import { headerRow, ID_COLUMN_LABEL } from "../lib/columns";
import { matchesFilters } from "../lib/filters";
import { randomUUID } from "node:crypto";
import type { NormalizedOrder } from "../lib/normalize";
import { mapOrderToRow } from "../lib/rowMapping";
import { planUpsert, type RowWrite } from "../lib/upsert";
import * as google from "./google.server";
import { GoogleAuthError } from "./google.server";
import { effectiveSettings, getOrCreateConfig, layoutKey } from "./shopData.server";

export type SyncKind = "BACKFILL" | "REBUILD" | "WEBHOOK" | "RECONCILE" | "MANUAL";

export const LOG_KEEP = 200;

/* ------------------------------------------------------------------ */
/* Per-shop lease (replaces the in-process queue)                      */
/* ------------------------------------------------------------------ */

/**
 * Takes the shop's DB lease so only one invocation writes its sheet at a time.
 * Serverless instances share nothing in memory, so the lease lives in Postgres.
 * Returns a token for releaseLease, or null when another invocation holds it.
 * The lease always expires on its own, so a killed function never blocks a shop for long.
 */
export async function acquireLease(shop: string, ms: number): Promise<string | null> {
  const now = new Date();
  const token = randomUUID();
  const res = await db.syncConfig.updateMany({
    where: { shop, OR: [{ lockedUntil: null }, { lockedUntil: { lt: now } }] },
    data: { lockedUntil: new Date(now.getTime() + ms), leaseOwner: token },
  });
  return res.count === 1 ? token : null;
}

export async function releaseLease(shop: string, token: string) {
  await db.syncConfig.updateMany({ where: { shop, leaseOwner: token }, data: { lockedUntil: null, leaseOwner: null } });
}

/* ------------------------------------------------------------------ */
/* Sheet session: keeps column A in memory for the duration of a job   */
/* ------------------------------------------------------------------ */

export class SheetSession {
  idColumn: unknown[] = [];
  gridRows = 1000;
  written = 0;

  constructor(
    private shop: string,
    private spreadsheetId: string,
    private sheetTitle: string,
    private sheetGid: number,
  ) {}

  async load() {
    [this.idColumn, this.gridRows] = await Promise.all([
      google.readIdColumn(this.shop, this.spreadsheetId, this.sheetTitle),
      google.getGridRowCount(this.shop, this.spreadsheetId, this.sheetGid),
    ]);
  }

  /** Writes first, then deletes bottom-up; plan row numbers refer to the pre-delete layout. */
  async upsert(rows: RowWrite[], removeIds: string[] = []) {
    if (!rows.length && !removeIds.length) return;
    const plan = planUpsert(this.idColumn, rows, removeIds);
    const writes = [...plan.updates, ...plan.appends];
    const maxRow = writes.reduce((m, w) => Math.max(m, w.rowNumber), 0);
    if (maxRow > this.gridRows) {
      await google.ensureGridRows(this.shop, this.spreadsheetId, this.sheetGid, maxRow, this.gridRows);
      this.gridRows = maxRow + 500;
    }
    await google.batchWriteRows(this.shop, this.spreadsheetId, this.sheetTitle, writes);
    await google.deleteRows(this.shop, this.spreadsheetId, this.sheetGid, plan.deletes);
    this.gridRows -= plan.deletes.length;
    this.idColumn = plan.nextIdColumn;
    this.written += writes.length;
  }

  get rowCount() {
    return this.idColumn.slice(1).filter((v) => v !== "" && v !== null && v !== undefined).length;
  }
}

/* ------------------------------------------------------------------ */
/* Logging                                                             */
/* ------------------------------------------------------------------ */

export async function startLog(shop: string, kind: SyncKind, message?: string) {
  return db.syncLog.create({ data: { shop, kind, status: "RUNNING", message } });
}

export async function finishLog(id: number, shop: string, status: "SUCCESS" | "ERROR" | "SKIPPED", rowsWritten: number, message?: string) {
  await db.syncLog.update({ where: { id }, data: { status, rowsWritten, message, finishedAt: new Date() } });
  const old = await db.syncLog.findMany({
    where: { shop },
    orderBy: { startedAt: "desc" },
    skip: LOG_KEEP,
    select: { id: true },
  });
  if (old.length) await db.syncLog.deleteMany({ where: { id: { in: old.map((o) => o.id) } } });
}

export function friendlyError(err: unknown): string {
  if (err instanceof GoogleAuthError) return err.message;
  const msg = (err as Error)?.message || String(err);
  if (/PERMISSION_DENIED|403/.test(msg)) return "Google denied access to the spreadsheet. Reconnect Google or rebuild the sheet.";
  return msg.slice(0, 500);
}

/* ------------------------------------------------------------------ */
/* Spreadsheet lifecycle                                               */
/* ------------------------------------------------------------------ */

/**
 * Makes sure the shop has a spreadsheet the app can write to and that its layout
 * matches the current settings. Returns { needsFull } when the sheet was (re)created
 * or cleared and every order must be written again.
 */
export async function prepareSheet(shop: string, forceRebuild: boolean) {
  const cfg = await getOrCreateConfig(shop);
  const eff = await effectiveSettings(shop);
  const key = layoutKey(eff.columns, eff.filters, cfg.backfillFrom, cfg.backfillTo);

  let { spreadsheetId, sheetGid } = cfg;
  let created = false;
  if (!spreadsheetId || sheetGid === null || !(await google.spreadsheetExists(shop, spreadsheetId))) {
    const s = await google.createSpreadsheet(shop, `OrderSheet Sync – ${shop.replace(".myshopify.com", "")} orders`, cfg.sheetTitle);
    spreadsheetId = s.spreadsheetId;
    sheetGid = s.sheetGid;
    created = true;
    await db.syncConfig.update({
      where: { shop },
      data: { spreadsheetId, sheetGid, spreadsheetUrl: s.spreadsheetUrl, lastSuccessAt: null, rowCount: 0 },
    });
  }

  const layoutChanged = cfg.layoutVersion !== key;
  const needsFull = created || forceRebuild || layoutChanged || !cfg.lastSuccessAt;
  if (needsFull && !created) await google.clearSheet(shop, spreadsheetId, cfg.sheetTitle);
  if (needsFull) {
    await google.writeCells(shop, spreadsheetId, google.a1(cfg.sheetTitle, "A1"), [headerRow(eff.columns)]);
    // lastSuccessAt=null: if this job dies before finishing, the next attempt is a full sync
    // again instead of an incremental one over a half-written sheet.
    await db.syncConfig.update({ where: { shop }, data: { layoutVersion: key, lastSuccessAt: null } });
  }

  const session = new SheetSession(shop, spreadsheetId, cfg.sheetTitle, sheetGid!);
  await session.load();
  if (String(session.idColumn[0] ?? "") !== ID_COLUMN_LABEL) {
    // Header was edited or removed by the merchant: restore it so column A stays the key.
    await google.writeCells(shop, spreadsheetId, google.a1(cfg.sheetTitle, "A1"), [headerRow(eff.columns)]);
    session.idColumn[0] = ID_COLUMN_LABEL;
  }
  return { cfg, eff, session, needsFull };
}

export function splitByFilters(
  orders: NormalizedOrder[],
  filters: Parameters<typeof matchesFilters>[1],
  window: { createdFrom: string | null; createdTo: string | null },
  columns: Parameters<typeof mapOrderToRow>[1],
  timezone: string,
) {
  const writes: RowWrite[] = [];
  const removes: string[] = [];
  for (const o of orders) {
    // Outside the date window: leave the sheet untouched (never delete history because of the window).
    if (!matchesFilters(o, { financial: [], fulfillment: [], includeTest: true, includeCancelled: true }, window)) continue;
    if (matchesFilters(o, filters)) {
      writes.push({ id: o.id, values: mapOrderToRow(o, columns, timezone), updatedAt: o.updatedAt });
    } else {
      removes.push(o.id);
    }
  }
  return { writes, removes };
}

/* ------------------------------------------------------------------ */
/* Compliance: blank customer cells for redacted orders                */
/* ------------------------------------------------------------------ */

/**
 * Blanks customer cells for the given orders. Returns "LOCKED" when a sync holds the sheet,
 * so the caller can queue the request (PendingRedaction) for the scheduled function.
 */
export async function redactOrdersInSheet(shop: string, orderIds: string[]): Promise<"DONE" | "LOCKED"> {
  if (!orderIds.length) return "DONE";
  const cfg = await db.syncConfig.findUnique({ where: { shop } });
  const conn = await db.googleConnection.findUnique({ where: { shop } });
  if (!cfg?.spreadsheetId || cfg.sheetGid === null || !conn) return "DONE";
  const eff = await effectiveSettings(shop);
  const sensitive = eff.columns
    .map((c, i) => ({ c, col: i + 2 })) // +1 for 1-based, +1 for the id column
    .filter(({ c }) => ["customer_name", "customer_email", "shipping_city", "shipping_country"].includes(c));
  if (!sensitive.length) return "DONE";
  const token = await acquireLease(shop, 30_000);
  if (!token) return "LOCKED";
  try {
    const session = new SheetSession(shop, cfg.spreadsheetId!, cfg.sheetTitle, cfg.sheetGid!);
    await session.load();
    const ids = session.idColumn.map((v) => String(v ?? "").replace(/^'/, ""));
    for (const orderId of orderIds) {
      const idx = ids.indexOf(String(orderId));
      if (idx < 1) continue;
      for (const { col } of sensitive) {
        await google.writeCells(shop, cfg.spreadsheetId!, google.a1(cfg.sheetTitle, `${colLetter(col)}${idx + 1}`), [["[redacted]"]]);
      }
    }
    return "DONE";
  } finally {
    await releaseLease(shop, token);
  }
}

export function colLetter(n: number): string {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
