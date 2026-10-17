import { beforeEach, describe, expect, it, vi } from "vitest";

// The route's collaborators are mocked: authenticate.webhook (HMAC check) and the sync service.
vi.mock("../app/shopify.server", () => ({ authenticate: { webhook: vi.fn() } }));
vi.mock("../app/services/webhookSync.server", () => ({
  syncOrderFromWebhook: vi.fn(),
  markDirty: vi.fn(async () => {}),
  queueRedactions: vi.fn(async () => {}),
  redactNow: vi.fn(async () => {}),
}));

process.env.WEBHOOK_INLINE_TIMEOUT_MS = "1000"; // minimum allowed; keeps the timeout test quick

const { authenticate } = await import("../app/shopify.server");
const svc = await import("../app/services/webhookSync.server");
const orders = await import("../app/routes/webhooks.orders");
const redact = await import("../app/routes/webhooks.customers.redact");

const webhook = authenticate.webhook as unknown as ReturnType<typeof vi.fn>;
const req = () => new Request("https://app.example/webhooks/orders", { method: "POST", body: "{}" });
const call = (route: { action: (args: any) => Promise<Response> }, context: unknown = {}) =>
  route.action({ request: req(), context, params: {} });

beforeEach(() => {
  vi.mocked(svc.syncOrderFromWebhook).mockReset();
  vi.mocked(svc.markDirty).mockClear();
  vi.mocked(svc.queueRedactions).mockClear();
  vi.mocked(svc.redactNow).mockReset();
  webhook.mockReset();
  webhook.mockResolvedValue({
    shop: "demo.myshopify.com",
    topic: "ORDERS_UPDATED",
    payload: { id: 5123456789012, admin_graphql_api_id: "gid://shopify/Order/5123456789012" },
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("orders webhook (serverless, inline upsert)", () => {
  it("verifies, upserts inline and answers 200", async () => {
    vi.mocked(svc.syncOrderFromWebhook).mockResolvedValue("SYNCED");
    const res = await call(orders);
    expect(res.status).toBe(200);
    expect(webhook).toHaveBeenCalledTimes(1);
    expect(svc.syncOrderFromWebhook).toHaveBeenCalledWith("demo.myshopify.com", "5123456789012");
    expect(svc.markDirty).not.toHaveBeenCalled();
  });

  it("answers 200 and marks the order dirty when the upsert fails", async () => {
    vi.mocked(svc.syncOrderFromWebhook).mockRejectedValue(new Error("Google 503"));
    const res = await call(orders);
    expect(res.status).toBe(200);
    expect(svc.markDirty).toHaveBeenCalledWith("demo.myshopify.com", ["5123456789012"], "inline error");
  });

  it("answers 200 within the guard when the upsert hangs, and keeps it alive via waitUntil", async () => {
    vi.mocked(svc.syncOrderFromWebhook).mockReturnValue(new Promise(() => {}));
    const waitUntil = vi.fn();
    const t0 = Date.now();
    const res = await call(orders, { waitUntil });
    expect(res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(2500);
    expect(svc.markDirty).toHaveBeenCalledWith("demo.myshopify.com", ["5123456789012"], "inline timeout");
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it("works without Netlify context (local dev)", async () => {
    vi.mocked(svc.syncOrderFromWebhook).mockResolvedValue("IGNORED");
    expect((await call(orders, undefined)).status).toBe(200);
  });

  it("rejects an invalid HMAC (authenticate.webhook throws a 401 Response) without doing work", async () => {
    webhook.mockRejectedValue(new Response(undefined, { status: 401 }));
    await expect(call(orders)).rejects.toMatchObject({ status: 401 });
    expect(svc.syncOrderFromWebhook).not.toHaveBeenCalled();
  });

  it("acknowledges a payload without an order id", async () => {
    webhook.mockResolvedValue({ shop: "demo.myshopify.com", topic: "ORDERS_CREATE", payload: {} });
    expect((await call(orders)).status).toBe(200);
    expect(svc.syncOrderFromWebhook).not.toHaveBeenCalled();
  });
});

describe("customers/redact webhook", () => {
  beforeEach(() => {
    webhook.mockResolvedValue({ shop: "demo.myshopify.com", topic: "CUSTOMERS_REDACT", payload: { orders_to_redact: [1, 2] } });
  });

  it("redacts inline when the sheet is free", async () => {
    const res = await call(redact);
    expect(res.status).toBe(200);
    expect(svc.redactNow).toHaveBeenCalledWith("demo.myshopify.com", ["1", "2"]);
    expect(svc.queueRedactions).not.toHaveBeenCalled();
  });

  it("queues the redaction for the scheduled function when it can't finish inline", async () => {
    vi.mocked(svc.redactNow).mockRejectedValue(new Error("Sheet is busy"));
    const res = await call(redact);
    expect(res.status).toBe(200);
    expect(svc.queueRedactions).toHaveBeenCalledWith("demo.myshopify.com", ["1", "2"]);
  });
});
