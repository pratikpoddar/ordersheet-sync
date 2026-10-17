/**
 * The fixed catalogue of exportable columns.
 * "Order ID" is always written as column A (it is the upsert key) and is not part of this list.
 */
export type ColumnKey =
  | "order_name"
  | "created_at"
  | "financial_status"
  | "fulfillment_status"
  | "subtotal"
  | "discounts"
  | "shipping"
  | "tax"
  | "total"
  | "currency"
  | "line_items"
  | "skus"
  | "quantity"
  | "tags"
  | "source"
  | "shipping_country"
  | "shipping_city"
  | "customer_name"
  | "customer_email";

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  /** Requires Shopify Protected Customer Data (Level 2) approval. */
  protectedData: boolean;
}

export const ID_COLUMN_LABEL = "Order ID";

export const COLUMNS: readonly ColumnDef[] = [
  { key: "order_name", label: "Order", protectedData: false },
  { key: "created_at", label: "Created at", protectedData: false },
  { key: "financial_status", label: "Payment status", protectedData: false },
  { key: "fulfillment_status", label: "Fulfillment status", protectedData: false },
  { key: "subtotal", label: "Subtotal", protectedData: false },
  { key: "discounts", label: "Discounts", protectedData: false },
  { key: "shipping", label: "Shipping", protectedData: false },
  { key: "tax", label: "Tax", protectedData: false },
  { key: "total", label: "Total", protectedData: false },
  { key: "currency", label: "Currency", protectedData: false },
  { key: "line_items", label: "Line items", protectedData: false },
  { key: "skus", label: "SKUs", protectedData: false },
  { key: "quantity", label: "Quantity", protectedData: false },
  { key: "tags", label: "Tags", protectedData: false },
  { key: "source", label: "Source", protectedData: false },
  { key: "shipping_country", label: "Shipping country", protectedData: true },
  { key: "shipping_city", label: "Shipping city", protectedData: true },
  { key: "customer_name", label: "Customer name", protectedData: true },
  { key: "customer_email", label: "Customer email", protectedData: true },
] as const;

/** Columns every shop gets (and the only ones on the Free plan). */
export const DEFAULT_COLUMNS: ColumnKey[] = [
  "order_name",
  "created_at",
  "financial_status",
  "fulfillment_status",
  "subtotal",
  "discounts",
  "shipping",
  "tax",
  "total",
  "currency",
  "line_items",
  "quantity",
];

const BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

export function isColumnKey(v: unknown): v is ColumnKey {
  return typeof v === "string" && BY_KEY.has(v as ColumnKey);
}

export function columnDef(key: ColumnKey): ColumnDef {
  return BY_KEY.get(key)!;
}

/**
 * Normalise a requested column list: drop unknown keys and duplicates,
 * drop protected columns unless the protected-data flag is on,
 * and order them by the catalogue order so the sheet layout is stable.
 */
export function normalizeColumns(
  requested: unknown[],
  opts: { protectedDataEnabled: boolean },
): ColumnKey[] {
  const wanted = new Set(requested.filter(isColumnKey));
  const out = COLUMNS.filter(
    (c) => wanted.has(c.key) && (opts.protectedDataEnabled || !c.protectedData),
  ).map((c) => c.key);
  return out.length ? out : [...DEFAULT_COLUMNS];
}

export function headerRow(columns: ColumnKey[]): string[] {
  return [ID_COLUMN_LABEL, ...columns.map((k) => columnDef(k).label)];
}
