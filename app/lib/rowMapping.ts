import type { ColumnKey } from "./columns";
import type { NormalizedOrder } from "./normalize";

export type Cell = string | number;

/**
 * Text that Sheets would treat as a formula when written with USER_ENTERED
 * (=, +, -, @) is prefixed with an apostrophe. This blocks formula injection
 * from merchant/customer-controlled text such as tags or product titles.
 */
export function safeText(v: string | null | undefined): string {
  if (v === null || v === undefined) return "";
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** Numeric money string -> number cell; missing -> empty cell. */
export function moneyCell(v: string | null): Cell {
  if (v === null || v === "") return "";
  const n = Number(v);
  return Number.isFinite(n) ? n : "";
}

/** "partially_refunded" -> "Partially refunded" */
export function humanizeStatus(v: string | null): string {
  if (!v) return "";
  const s = v.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * ISO timestamp -> "YYYY-MM-DD HH:MM:SS" in the shop's timezone.
 * Written with USER_ENTERED, Sheets stores this as a real date-time (sortable, filterable).
 */
export function formatDate(iso: string | null, timeZone = "UTC"): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

export function lineItemsSummary(order: NormalizedOrder): string {
  return order.lineItems
    .map((li) => {
      const variant =
        li.variantTitle && li.variantTitle !== "Default Title"
          ? ` (${li.variantTitle})`
          : "";
      return `${li.quantity}x ${li.title}${variant}`;
    })
    .join("; ");
}

export function skuList(order: NormalizedOrder): string {
  return [...new Set(order.lineItems.map((li) => li.sku).filter(Boolean))].join(", ");
}

export function totalQuantity(order: NormalizedOrder): number {
  return order.lineItems.reduce((s, li) => s + (Number.isFinite(li.quantity) ? li.quantity : 0), 0);
}

export function cellFor(order: NormalizedOrder, key: ColumnKey, timeZone: string): Cell {
  switch (key) {
    case "order_name":
      return safeText(order.name);
    case "created_at":
      return formatDate(order.createdAt, timeZone);
    case "financial_status":
      return humanizeStatus(order.financialStatus);
    case "fulfillment_status":
      return humanizeStatus(order.fulfillmentStatus);
    case "subtotal":
      return moneyCell(order.subtotal);
    case "discounts":
      return moneyCell(order.discounts);
    case "shipping":
      return moneyCell(order.shipping);
    case "tax":
      return moneyCell(order.tax);
    case "total":
      return moneyCell(order.total);
    case "currency":
      return safeText(order.currency);
    case "line_items":
      return safeText(lineItemsSummary(order));
    case "skus":
      return safeText(skuList(order));
    case "quantity":
      return totalQuantity(order);
    case "tags":
      return safeText(order.tags.join(", "));
    case "source":
      return safeText(order.sourceName);
    case "shipping_country":
      return safeText(order.shippingCountry);
    case "shipping_city":
      return safeText(order.shippingCity);
    case "customer_name":
      return safeText(order.customerName);
    case "customer_email":
      return safeText(order.customerEmail);
  }
}

/** Column A is always the order id, written as text so Sheets never reformats it. */
export function idCell(orderId: string): string {
  return `'${orderId}`;
}

export function mapOrderToRow(
  order: NormalizedOrder,
  columns: ColumnKey[],
  timeZone = "UTC",
): Cell[] {
  return [idCell(order.id), ...columns.map((k) => cellFor(order, k, timeZone))];
}
