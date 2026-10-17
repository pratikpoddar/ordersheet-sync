import { describe, expect, it } from "vitest";
import { DEFAULT_COLUMNS } from "../app/lib/columns";
import { buildOrderSearchQuery, EMPTY_FILTERS, matchesFilters } from "../app/lib/filters";
import { fromGraphQL } from "../app/lib/normalize";
import { entitlementsFor, sanitizeSettings } from "../app/lib/plans";
import { graphqlOrder } from "./fixtures";

const now = new Date("2026-10-17T00:00:00Z");

describe("server-side plan gating", () => {
  it("Free: forces default columns, 60-day floor and no filters", () => {
    const eff = sanitizeSettings(
      "FREE",
      {
        columns: ["order_name", "skus"],
        backfillFrom: "2025-01-01",
        backfillTo: null,
        filters: { financial: ["paid"], fulfillment: [], includeTest: true, includeCancelled: false },
      },
      { protectedDataEnabled: false, now },
    );
    expect(eff.columns).toEqual(DEFAULT_COLUMNS);
    expect(eff.backfillFrom).toBe("2026-08-18");
    expect(eff.filters).toEqual(EMPTY_FILTERS);
    expect(eff.clamped.length).toBe(3);
  });

  it("Pro: keeps custom columns, history and filters, drops invalid statuses", () => {
    const eff = sanitizeSettings(
      "PRO",
      {
        columns: ["skus", "order_name"],
        backfillFrom: "2024-01-01",
        backfillTo: "2024-12-31",
        filters: { financial: ["paid", "hacked"], fulfillment: ["fulfilled"], includeTest: false, includeCancelled: true },
      },
      { protectedDataEnabled: false, now },
    );
    expect(eff.columns).toEqual(["order_name", "skus"]);
    expect(eff.backfillFrom).toBe("2024-01-01");
    expect(eff.filters.financial).toEqual(["paid"]);
    expect(eff.clamped).toEqual([]);
  });

  it("Pro still cannot get protected columns while the flag is off", () => {
    const eff = sanitizeSettings(
      "PRO",
      { columns: ["order_name", "customer_email"], backfillFrom: null, backfillTo: null, filters: EMPTY_FILTERS },
      { protectedDataEnabled: false, now },
    );
    expect(eff.columns).toEqual(["order_name"]);
  });

  it("swaps a reversed date range", () => {
    const eff = sanitizeSettings(
      "PRO",
      { columns: [], backfillFrom: "2026-05-01", backfillTo: "2026-01-01", filters: EMPTY_FILTERS },
      { protectedDataEnabled: false, now },
    );
    expect([eff.backfillFrom, eff.backfillTo]).toEqual(["2026-01-01", "2026-05-01"]);
  });

  it("entitlements match the pricing page", () => {
    expect(entitlementsFor("FREE")).toMatchObject({ maxHistoryDays: 60, realtimeWebhooks: false, reconcileEveryMinutes: 1440 });
    expect(entitlementsFor("PRO")).toMatchObject({ maxHistoryDays: null, realtimeWebhooks: true, customColumns: true });
  });
});

describe("filters", () => {
  const order = fromGraphQL(graphqlOrder); // partially_refunded, partially_fulfilled

  it("builds a Shopify search query", () => {
    expect(
      buildOrderSearchQuery({
        createdFrom: "2026-01-01",
        createdTo: "2026-02-01",
        filters: { financial: ["paid", "refunded"], fulfillment: ["unfulfilled"], includeTest: false, includeCancelled: false },
      }),
    ).toBe(
      "created_at:>=2026-01-01 created_at:<=2026-02-01T23:59:59Z (financial_status:paid OR financial_status:refunded) (fulfillment_status:unshipped) test:false -status:cancelled",
    );
  });

  it("matches locally", () => {
    expect(matchesFilters(order, EMPTY_FILTERS)).toBe(true);
    expect(matchesFilters(order, { ...EMPTY_FILTERS, financial: ["paid"] })).toBe(false);
    expect(matchesFilters(order, { ...EMPTY_FILTERS, financial: ["partially_refunded"] })).toBe(true);
    expect(matchesFilters({ ...order, test: true }, EMPTY_FILTERS)).toBe(false);
    expect(matchesFilters({ ...order, cancelledAt: "2026-10-03T00:00:00Z" }, { ...EMPTY_FILTERS, includeCancelled: false })).toBe(false);
    expect(matchesFilters(order, EMPTY_FILTERS, { createdFrom: "2026-10-05" })).toBe(false);
  });
});

import { isReconcileDue } from "../app/lib/schedule";

describe("reconciliation schedule", () => {
  const h = (n: number) => new Date(now.getTime() - n * 3_600_000);
  it("Free is daily, Pro is hourly", () => {
    expect(isReconcileDue({ plan: "FREE", lastReconciledAt: h(23), lastErrorAt: null }, now)).toBe(false);
    expect(isReconcileDue({ plan: "FREE", lastReconciledAt: h(24), lastErrorAt: null }, now)).toBe(true);
    expect(isReconcileDue({ plan: "PRO", lastReconciledAt: h(1), lastErrorAt: null }, now)).toBe(true);
    expect(isReconcileDue({ plan: "PRO", lastReconciledAt: h(0.5), lastErrorAt: null }, now)).toBe(false);
  });
  it("never-synced shops are due; recent failures cool down for an hour", () => {
    expect(isReconcileDue({ plan: "FREE", lastReconciledAt: null, lastErrorAt: null }, now)).toBe(true);
    expect(isReconcileDue({ plan: "PRO", lastReconciledAt: h(5), lastErrorAt: h(0.5) }, now)).toBe(false);
    expect(isReconcileDue({ plan: "PRO", lastReconciledAt: h(5), lastErrorAt: h(1.5) }, now)).toBe(true);
  });
});
