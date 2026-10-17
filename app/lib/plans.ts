import { DEFAULT_COLUMNS, normalizeColumns, type ColumnKey } from "./columns";
import { FINANCIAL_STATUSES, FULFILLMENT_STATUSES, type StatusFilters } from "./filters";

export const PRO_PLAN = "OrderSheet Sync Pro";
export type PlanTier = "FREE" | "PRO";

export interface Entitlements {
  tier: PlanTier;
  maxSheets: number;
  /** null = unlimited history */
  maxHistoryDays: number | null;
  realtimeWebhooks: boolean;
  customColumns: boolean;
  filters: boolean;
  /** How often the scheduled reconciliation runs for this shop. */
  reconcileEveryMinutes: number;
}

export const FREE_HISTORY_DAYS = 60;

export function entitlementsFor(tier: PlanTier): Entitlements {
  return tier === "PRO"
    ? {
        tier,
        maxSheets: 1,
        maxHistoryDays: null,
        realtimeWebhooks: true,
        customColumns: true,
        filters: true,
        reconcileEveryMinutes: 60,
      }
    : {
        tier,
        maxSheets: 1,
        maxHistoryDays: FREE_HISTORY_DAYS,
        realtimeWebhooks: false,
        customColumns: false,
        filters: false,
        reconcileEveryMinutes: 24 * 60,
      };
}

export interface RequestedSettings {
  columns: unknown[];
  backfillFrom: string | null; // YYYY-MM-DD
  backfillTo: string | null; // YYYY-MM-DD
  filters: StatusFilters;
}

export interface EffectiveSettings {
  columns: ColumnKey[];
  backfillFrom: string | null;
  backfillTo: string | null;
  filters: StatusFilters;
  /** Human-readable notes about anything the plan changed. */
  clamped: string[];
}

const DAY_MS = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const validDay = (v: string | null) =>
  v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) ? v : null;

/**
 * Server-side gate. Whatever the browser posts, the stored/used settings
 * are only ever what the plan allows.
 */
export function sanitizeSettings(
  tier: PlanTier,
  req: RequestedSettings,
  opts: { protectedDataEnabled: boolean; now?: Date },
): EffectiveSettings {
  const ent = entitlementsFor(tier);
  const now = opts.now ?? new Date();
  const clamped: string[] = [];

  let columns = normalizeColumns(req.columns, opts);
  if (!ent.customColumns) {
    const same =
      columns.length === DEFAULT_COLUMNS.length &&
      columns.every((c, i) => c === DEFAULT_COLUMNS[i]);
    if (!same) clamped.push("Custom columns need the Pro plan; default columns used.");
    columns = [...DEFAULT_COLUMNS];
  }

  let backfillFrom = validDay(req.backfillFrom);
  let backfillTo = validDay(req.backfillTo);
  if (backfillFrom && backfillTo && backfillFrom > backfillTo) {
    [backfillFrom, backfillTo] = [backfillTo, backfillFrom];
  }
  if (ent.maxHistoryDays !== null) {
    const floor = isoDay(new Date(now.getTime() - ent.maxHistoryDays * DAY_MS));
    if (!backfillFrom || backfillFrom < floor) {
      if (backfillFrom) clamped.push(`Free plan exports the last ${ent.maxHistoryDays} days only.`);
      backfillFrom = floor;
    }
    if (backfillTo && backfillTo < floor) backfillTo = null;
  }

  let filters: StatusFilters = {
    financial: (req.filters?.financial ?? []).filter((s) =>
      (FINANCIAL_STATUSES as readonly string[]).includes(s),
    ),
    fulfillment: (req.filters?.fulfillment ?? []).filter((s) =>
      (FULFILLMENT_STATUSES as readonly string[]).includes(s),
    ),
    includeTest: Boolean(req.filters?.includeTest),
    includeCancelled: req.filters?.includeCancelled !== false,
  };
  if (!ent.filters) {
    if (filters.financial.length || filters.fulfillment.length) {
      clamped.push("Status filters need the Pro plan.");
    }
    filters = { financial: [], fulfillment: [], includeTest: false, includeCancelled: true };
  }

  return { columns, backfillFrom, backfillTo, filters, clamped };
}
