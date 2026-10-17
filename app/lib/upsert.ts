import type { Cell } from "./rowMapping";

export interface RowWrite {
  id: string;
  values: Cell[];
  /** Used to resolve duplicates inside one batch: newest wins. */
  updatedAt?: string;
}

export interface UpsertPlan {
  /** Overwrite an existing row (1-based sheet row number). */
  updates: { rowNumber: number; id: string; values: Cell[] }[];
  /** Append after the last used row, in this order. */
  appends: { rowNumber: number; id: string; values: Cell[] }[];
  /** Rows to delete (duplicates of an id, or ids removed by filters), sorted descending
   *  so deleting them one by one never shifts a row still to be deleted. */
  deletes: number[];
  /** The id column after the plan is applied (index 0 = sheet row 1). */
  nextIdColumn: string[];
}

/** Normalise a cell read back from column A ("'123", 123, " 123 ") -> "123". */
export function normalizeIdCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).replace(/^'/, "").trim();
}

/**
 * Pure planning step of the sheet upsert.
 *
 * @param idColumn  current values of column A, index 0 = row 1 (the header)
 * @param rows      rows to write, keyed by order id
 * @param removeIds ids whose rows must disappear (e.g. no longer match filters)
 * @param headerRows number of header rows to skip (default 1)
 *
 * Guarantees: each order id ends up on exactly one row; existing rows are updated in place;
 * new ids are appended; duplicate rows already in the sheet are scheduled for deletion.
 */
export function planUpsert(
  idColumn: unknown[],
  rows: RowWrite[],
  removeIds: Iterable<string> = [],
  headerRows = 1,
): UpsertPlan {
  // 1. Collapse duplicates inside the batch: keep the newest version of each order.
  const latest = new Map<string, RowWrite>();
  for (const r of rows) {
    const id = normalizeIdCell(r.id);
    if (!id) continue;
    const prev = latest.get(id);
    if (!prev || !prev.updatedAt || !r.updatedAt || r.updatedAt >= prev.updatedAt) {
      latest.set(id, { ...r, id });
    }
  }

  // 2. Index the sheet. First occurrence wins; later occurrences are duplicates.
  const ids = idColumn.map(normalizeIdCell);
  const rowOf = new Map<string, number>();
  const deletes = new Set<number>();
  let lastUsedRow = headerRows;
  for (let i = headerRows; i < ids.length; i++) {
    const id = ids[i];
    if (!id) continue;
    const rowNumber = i + 1;
    lastUsedRow = rowNumber;
    if (rowOf.has(id)) deletes.add(rowNumber);
    else rowOf.set(id, rowNumber);
  }

  const remove = new Set([...removeIds].map(normalizeIdCell));
  for (const id of remove) {
    if (latest.has(id)) latest.delete(id); // removal beats write
    const rn = rowOf.get(id);
    if (rn) deletes.add(rn);
  }

  // 3. Split into in-place updates and appends.
  const updates: UpsertPlan["updates"] = [];
  const appends: UpsertPlan["appends"] = [];
  let nextRow = lastUsedRow;
  for (const r of latest.values()) {
    const existing = rowOf.get(r.id);
    if (existing) updates.push({ rowNumber: existing, id: r.id, values: r.values });
    else appends.push({ rowNumber: ++nextRow, id: r.id, values: r.values });
  }
  updates.sort((a, b) => a.rowNumber - b.rowNumber);

  // 4. Compute the id column after writes and deletes, so callers can keep an
  //    in-memory index across pages without re-reading the sheet.
  const after: string[] = ids.slice(0, Math.max(ids.length, nextRow));
  for (const a of appends) after[a.rowNumber - 1] = a.id;
  const sortedDeletes = [...deletes].sort((a, b) => b - a);
  for (const rn of sortedDeletes) after.splice(rn - 1, 1);
  // Trim trailing blanks
  while (after.length > headerRows && !after[after.length - 1]) after.pop();
  for (let i = 0; i < after.length; i++) if (after[i] === undefined) after[i] = "";

  return { updates, appends, deletes: sortedDeletes, nextIdColumn: after };
}
