import { describe, expect, it } from "vitest";
import { normalizeIdCell, planUpsert } from "../app/lib/upsert";

const header = "Order ID";
const row = (id: string, v = id) => ({ id, values: [`'${id}`, v] });

/** Apply a plan to an in-memory sheet exactly the way the sync engine applies it to Google. */
function apply(sheet: (string | number)[][], plan: ReturnType<typeof planUpsert>) {
  const s = sheet.map((r) => [...r]);
  for (const w of [...plan.updates, ...plan.appends]) s[w.rowNumber - 1] = w.values as (string | number)[];
  for (const rn of plan.deletes) s.splice(rn - 1, 1);
  return s.map((r) => r ?? []);
}
const idCol = (sheet: (string | number)[][]) => sheet.map((r) => r[0]);

describe("planUpsert", () => {
  it("appends new orders after the header on an empty sheet", () => {
    const plan = planUpsert([header], [row("1"), row("2")]);
    expect(plan.updates).toEqual([]);
    expect(plan.appends.map((a) => a.rowNumber)).toEqual([2, 3]);
    expect(plan.nextIdColumn).toEqual([header, "1", "2"]);
  });

  it("updates existing rows in place instead of duplicating", () => {
    const plan = planUpsert([header, "'1", "'2", "'3"], [row("2", "new")]);
    expect(plan.appends).toEqual([]);
    expect(plan.updates).toEqual([{ rowNumber: 3, id: "2", values: ["'2", "new"] }]);
  });

  it("mixes updates and appends", () => {
    const plan = planUpsert([header, "1", "2"], [row("3"), row("1", "x")]);
    expect(plan.updates.map((u) => u.rowNumber)).toEqual([2]);
    expect(plan.appends.map((a) => [a.id, a.rowNumber])).toEqual([["3", 4]]);
  });

  it("collapses duplicates within one batch, newest updatedAt wins", () => {
    const plan = planUpsert(
      [header],
      [
        { id: "7", values: ["'7", "new"], updatedAt: "2026-10-02T00:00:00Z" },
        { id: "7", values: ["'7", "old"], updatedAt: "2026-10-01T00:00:00Z" },
      ],
    );
    expect(plan.appends).toHaveLength(1);
    expect(plan.appends[0].values[1]).toBe("new");
  });

  it("matches ids regardless of apostrophe prefix or numeric cells", () => {
    expect(normalizeIdCell("'5123456789012")).toBe("5123456789012");
    expect(normalizeIdCell(5123456789012)).toBe("5123456789012");
    const plan = planUpsert([header, 5123456789012], [row("5123456789012", "x")]);
    expect(plan.updates).toHaveLength(1);
    expect(plan.appends).toHaveLength(0);
  });

  it("schedules duplicate rows already in the sheet for deletion, bottom-up", () => {
    const plan = planUpsert([header, "1", "2", "1", "3", "2"], [row("1", "x")]);
    expect(plan.updates).toEqual([{ rowNumber: 2, id: "1", values: ["'1", "x"] }]);
    expect(plan.deletes).toEqual([6, 4]);
    expect(plan.nextIdColumn).toEqual([header, "1", "2", "3"]);
  });

  it("removes rows for ids that no longer match filters, and removal beats a write", () => {
    const plan = planUpsert([header, "1", "2", "3"], [row("2", "x"), row("4")], ["2"]);
    expect(plan.updates).toEqual([]);
    expect(plan.appends.map((a) => a.id)).toEqual(["4"]);
    expect(plan.deletes).toEqual([3]);
    expect(plan.nextIdColumn).toEqual([header, "1", "3", "4"]);
  });

  it("ignores removal of ids that are not in the sheet", () => {
    const plan = planUpsert([header, "1"], [], ["99"]);
    expect(plan.deletes).toEqual([]);
  });

  it("appends after the last used row even when the merchant left blank rows", () => {
    const plan = planUpsert([header, "1", "", "2"], [row("3")]);
    expect(plan.appends[0].rowNumber).toBe(5);
  });

  it("is idempotent: replaying the same batch never adds rows", () => {
    let sheet: (string | number)[][] = [[header]];
    const batch = [row("1"), row("2"), row("3")];
    for (let i = 0; i < 3; i++) {
      const plan = planUpsert(idCol(sheet), batch);
      sheet = apply(sheet, plan);
      expect(idCol(sheet).map(normalizeIdCell)).toEqual(plan.nextIdColumn);
    }
    expect(sheet).toHaveLength(4);
  });

  it("nextIdColumn always equals the id column of the sheet after the plan is applied", () => {
    // Randomised property check across many batches (fixed seed for reproducibility).
    let seed = 42;
    const rand = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) % n);
    let sheet: (string | number)[][] = [[header]];
    let index: unknown[] = [header];
    for (let i = 0; i < 200; i++) {
      const writes = Array.from({ length: rand(5) }, () => row(String(rand(30)), `v${i}`));
      const removes = Array.from({ length: rand(2) }, () => String(rand(30)));
      const plan = planUpsert(index, writes, removes);
      sheet = apply(sheet, plan);
      index = plan.nextIdColumn;
      const ids = idCol(sheet).map(normalizeIdCell);
      expect(ids).toEqual(plan.nextIdColumn);
      // No order id ever appears twice.
      const body = ids.slice(1).filter(Boolean);
      expect(new Set(body).size).toBe(body.length);
    }
  });
});
