import type { NormalizedOrder } from "./normalize";

export const FINANCIAL_STATUSES = [
  "pending",
  "authorized",
  "partially_paid",
  "paid",
  "partially_refunded",
  "refunded",
  "voided",
] as const;

export const FULFILLMENT_STATUSES = [
  "unfulfilled",
  "partially_fulfilled",
  "fulfilled",
] as const;

export interface StatusFilters {
  financial: string[];
  fulfillment: string[];
  includeTest: boolean;
  includeCancelled: boolean;
}

export const EMPTY_FILTERS: StatusFilters = {
  financial: [],
  fulfillment: [],
  includeTest: false,
  includeCancelled: true,
};

/** Shopify order search syntax for the fulfillment_status filter. */
const FULFILLMENT_QUERY: Record<string, string> = {
  unfulfilled: "unshipped",
  partially_fulfilled: "partial",
  fulfilled: "shipped",
};

/**
 * Build the `query:` argument for the GraphQL `orders` connection.
 * The same rules are re-checked locally with `matchesFilters`, so a search-syntax
 * quirk can never put a non-matching order in the sheet.
 */
export function buildOrderSearchQuery(opts: {
  createdFrom?: string | null; // YYYY-MM-DD
  createdTo?: string | null; // YYYY-MM-DD (inclusive)
  updatedSince?: string | null; // ISO
  filters: StatusFilters;
}): string {
  const parts: string[] = [];
  if (opts.createdFrom) parts.push(`created_at:>=${opts.createdFrom}`);
  if (opts.createdTo) parts.push(`created_at:<=${opts.createdTo}T23:59:59Z`);
  if (opts.updatedSince) parts.push(`updated_at:>='${opts.updatedSince}'`);
  const f = opts.filters;
  if (f.financial.length) {
    parts.push(`(${f.financial.map((s) => `financial_status:${s}`).join(" OR ")})`);
  }
  if (f.fulfillment.length) {
    parts.push(
      `(${f.fulfillment.map((s) => `fulfillment_status:${FULFILLMENT_QUERY[s] ?? s}`).join(" OR ")})`,
    );
  }
  if (!f.includeTest) parts.push("test:false");
  if (!f.includeCancelled) parts.push("-status:cancelled");
  return parts.join(" ");
}

export function matchesFilters(
  order: NormalizedOrder,
  f: StatusFilters,
  window?: { createdFrom?: string | null; createdTo?: string | null },
): boolean {
  if (!f.includeTest && order.test) return false;
  if (!f.includeCancelled && order.cancelledAt) return false;
  if (f.financial.length && !f.financial.includes(order.financialStatus ?? "")) return false;
  if (f.fulfillment.length && !f.fulfillment.includes(order.fulfillmentStatus ?? "")) return false;
  const day = order.createdAt?.slice(0, 10);
  if (window?.createdFrom && day && day < window.createdFrom) return false;
  if (window?.createdTo && day && day > window.createdTo) return false;
  return true;
}
