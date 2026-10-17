import { describe, expect, it } from "vitest";
import { COLUMNS, DEFAULT_COLUMNS, headerRow, normalizeColumns, type ColumnKey } from "../app/lib/columns";
import { fromGraphQL, fromWebhook, orderIdFromGid } from "../app/lib/normalize";
import {
  formatDate,
  humanizeStatus,
  lineItemsSummary,
  mapOrderToRow,
  moneyCell,
  safeText,
  skuList,
  totalQuantity,
} from "../app/lib/rowMapping";
import { graphqlOrder, webhookOrder } from "./fixtures";

const ALL = COLUMNS.map((c) => c.key) as ColumnKey[];

describe("normalisation", () => {
  it("extracts numeric ids from gids and plain ids", () => {
    expect(orderIdFromGid("gid://shopify/Order/123")).toBe("123");
    expect(orderIdFromGid(456)).toBe("456");
  });

  it("GraphQL and webhook payloads normalise to the same order", () => {
    const a = fromGraphQL(graphqlOrder);
    const b = fromWebhook(webhookOrder);
    expect(a.id).toBe("5123456789012");
    expect(b.id).toBe(a.id);
    expect(b.financialStatus).toBe(a.financialStatus);
    expect(b.fulfillmentStatus).toBe(a.fulfillmentStatus);
    expect(b.tags).toEqual(a.tags);
    expect(b.lineItems).toEqual(a.lineItems);
    expect(b.customerName).toBe(a.customerName);
    // Same instant, different offsets: the mapped rows must be identical.
    expect(mapOrderToRow(b, ALL, "America/Chicago")).toEqual(mapOrderToRow(a, ALL, "America/Chicago"));
  });

  it("webhook null fulfillment_status means unfulfilled", () => {
    expect(fromWebhook({ ...webhookOrder, fulfillment_status: null }).fulfillmentStatus).toBe("unfulfilled");
  });

  it("falls back to summing shipping_lines when the shipping money set is missing", () => {
    const o = fromWebhook({
      ...webhookOrder,
      total_shipping_price_set: undefined,
      shipping_lines: [{ price: "3.50" }, { price: "1.25" }],
    });
    expect(o.shipping).toBe("4.75");
  });
});

describe("cell helpers", () => {
  it("escapes formula-looking text", () => {
    expect(safeText("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(safeText("+1 555")).toBe("'+1 555");
    expect(safeText("-x")).toBe("'-x");
    expect(safeText("@me")).toBe("'@me");
    expect(safeText("normal")).toBe("normal");
    expect(safeText(null)).toBe("");
  });

  it("converts money strings to numbers and keeps blanks blank", () => {
    expect(moneyCell("102.20")).toBe(102.2);
    expect(moneyCell("0.00")).toBe(0);
    expect(moneyCell(null)).toBe("");
  });

  it("humanises statuses", () => {
    expect(humanizeStatus("partially_refunded")).toBe("Partially refunded");
    expect(humanizeStatus(null)).toBe("");
  });

  it("formats dates in the shop timezone", () => {
    expect(formatDate("2026-10-01T18:30:00Z", "UTC")).toBe("2026-10-01 18:30:00");
    expect(formatDate("2026-10-01T18:30:00Z", "Asia/Kolkata")).toBe("2026-10-02 00:00:00");
    expect(formatDate("2026-10-01T18:30:00Z", "America/New_York")).toBe("2026-10-01 14:30:00");
    expect(formatDate(null)).toBe("");
    expect(formatDate("not a date")).toBe("");
  });

  it("summarises line items, de-duplicates SKUs and sums quantity", () => {
    const o = fromGraphQL(graphqlOrder);
    expect(lineItemsSummary(o)).toBe("2x Blue Shirt (M); 1x Hat; 3x Sticker");
    expect(skuList(o)).toBe("SH-BL-M, HAT-1");
    expect(totalQuantity(o)).toBe(6);
  });
});

describe("mapOrderToRow", () => {
  it("maps the default columns in catalogue order with the id first", () => {
    const row = mapOrderToRow(fromGraphQL(graphqlOrder), DEFAULT_COLUMNS, "UTC");
    expect(row).toEqual([
      "'5123456789012",
      "#1001",
      "2026-10-01 18:30:00",
      "Partially refunded",
      "Partially fulfilled",
      90,
      10,
      5,
      7.2,
      102.2,
      "USD",
      "2x Blue Shirt (M); 1x Hat; 3x Sticker",
      6,
    ]);
    expect(row.length).toBe(headerRow(DEFAULT_COLUMNS).length);
  });

  it("maps every column, escaping injected tags", () => {
    const row = mapOrderToRow(fromGraphQL(graphqlOrder), ALL, "UTC");
    const header = headerRow(ALL);
    const byLabel = Object.fromEntries(header.map((h, i) => [h, row[i]]));
    expect(byLabel["Tags"]).toBe("VIP, =HYPERLINK(\"http://evil\")"); // starts with V, safe
    expect(byLabel["SKUs"]).toBe("SH-BL-M, HAT-1");
    expect(byLabel["Source"]).toBe("web");
    expect(byLabel["Customer email"]).toBe("jane@example.com");
    expect(byLabel["Shipping city"]).toBe("Austin");
  });

  it("escapes a tag list that starts with a formula", () => {
    const o = fromGraphQL({ ...graphqlOrder, tags: ["=cmd|' /C calc'!A0"] });
    const row = mapOrderToRow(o, ["tags"], "UTC");
    expect(row[1]).toBe("'=cmd|' /C calc'!A0");
  });

  it("writes empty cells, not 'null', for missing values", () => {
    const o = fromGraphQL({ ...graphqlOrder, totalTaxSet: null, sourceName: null, shippingAddress: null });
    const row = mapOrderToRow(o, ["tax", "source", "shipping_country"], "UTC");
    expect(row.slice(1)).toEqual(["", "", ""]);
  });
});

describe("column normalisation", () => {
  it("drops unknown and duplicate keys and keeps catalogue order", () => {
    expect(normalizeColumns(["total", "bogus", "order_name", "total"], { protectedDataEnabled: false })).toEqual([
      "order_name",
      "total",
    ]);
  });

  it("strips protected columns while the flag is off", () => {
    expect(
      normalizeColumns(["order_name", "customer_email", "customer_name"], { protectedDataEnabled: false }),
    ).toEqual(["order_name"]);
    expect(
      normalizeColumns(["order_name", "customer_email"], { protectedDataEnabled: true }),
    ).toEqual(["order_name", "customer_email"]);
  });

  it("falls back to defaults when nothing valid is selected", () => {
    expect(normalizeColumns([], { protectedDataEnabled: false })).toEqual(DEFAULT_COLUMNS);
  });
});
