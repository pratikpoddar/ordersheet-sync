import db from "../db.server";
import { config } from "../config.server";
import { DEFAULT_COLUMNS, type ColumnKey } from "../lib/columns";
import { EMPTY_FILTERS, type StatusFilters } from "../lib/filters";
import { PRO_PLAN, sanitizeSettings, type EffectiveSettings, type PlanTier } from "../lib/plans";
import { revokeAndDelete } from "./google.server";

export async function ensureShop(shop: string) {
  return db.shop.upsert({ where: { shop }, create: { shop }, update: {} });
}

export async function getPlan(shop: string): Promise<PlanTier> {
  const row = await db.shop.findUnique({ where: { shop } });
  return row?.plan === "PRO" ? "PRO" : "FREE";
}

export async function setPlanFromSubscriptions(shop: string, activeNames: string[]): Promise<PlanTier> {
  const plan: PlanTier = activeNames.includes(PRO_PLAN) ? "PRO" : "FREE";
  await db.shop.upsert({
    where: { shop },
    create: { shop, plan, planCheckedAt: new Date() },
    update: { plan, planCheckedAt: new Date() },
  });
  return plan;
}

export async function getOrCreateConfig(shop: string) {
  return db.syncConfig.upsert({
    where: { shop },
    create: { shop, columns: JSON.stringify(DEFAULT_COLUMNS), filters: JSON.stringify(EMPTY_FILTERS) },
    update: {},
  });
}

export function parseStored(cfg: { columns: string; filters: string }) {
  let columns: unknown[] = DEFAULT_COLUMNS;
  let filters: StatusFilters = EMPTY_FILTERS;
  try {
    const c = JSON.parse(cfg.columns);
    if (Array.isArray(c)) columns = c;
  } catch {}
  try {
    filters = { ...EMPTY_FILTERS, ...JSON.parse(cfg.filters || "{}") };
  } catch {}
  return { columns, filters };
}

/** Re-applies the CURRENT plan to stored settings (handles downgrades). */
export async function effectiveSettings(shop: string): Promise<EffectiveSettings & { plan: PlanTier }> {
  const [plan, cfg] = await Promise.all([getPlan(shop), getOrCreateConfig(shop)]);
  const stored = parseStored(cfg);
  const eff = sanitizeSettings(
    plan,
    { columns: stored.columns, filters: stored.filters, backfillFrom: cfg.backfillFrom, backfillTo: cfg.backfillTo },
    { protectedDataEnabled: config.protectedCustomerData() },
  );
  return { ...eff, plan };
}

/**
 * Identifies the sheet layout. Uses the merchant's STORED date range (not the Free plan's
 * rolling 60-day floor) so the sheet is not rebuilt every day.
 */
export function layoutKey(columns: ColumnKey[], filters: StatusFilters, from: string | null, to: string | null) {
  return JSON.stringify({ c: columns, f: filters, from, to });
}

/** app/uninstalled and shop/redact: remove everything we hold for the shop. */
export async function purgeShop(shop: string) {
  await revokeAndDelete(shop).catch((e) => console.warn(`[purge] google revoke failed for ${shop}`, e));
  await db.$transaction([
    db.syncLog.deleteMany({ where: { shop } }),
    db.dirtyOrder.deleteMany({ where: { shop } }),
    db.pendingRedaction.deleteMany({ where: { shop } }),
    db.syncConfig.deleteMany({ where: { shop } }),
    db.googleConnection.deleteMany({ where: { shop } }),
    db.shop.deleteMany({ where: { shop } }),
    db.session.deleteMany({ where: { shop } }),
  ]);
}
