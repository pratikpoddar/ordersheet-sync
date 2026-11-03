import { beforeEach, describe, expect, it, vi } from "vitest";
import { isProSubscription, pricingPlansUrl, tierFromSubscriptions } from "../app/lib/plans";

describe("managed pricing helpers", () => {
  it("builds Shopify's hosted plan page URL", () => {
    expect(pricingPlansUrl("tinkerer-store-r5yvie1m.myshopify.com")).toBe(
      "https://admin.shopify.com/store/tinkerer-store-r5yvie1m/charges/ordersheet-sync-1/pricing_plans",
    );
  });

  it("recognises Pro from managed pricing, legacy Billing API and price", () => {
    expect(isProSubscription({ name: "Pro", status: "ACTIVE" })).toBe(true);
    expect(isProSubscription({ name: "OrderSheet Sync Pro", status: "ACTIVE" })).toBe(true);
    expect(isProSubscription({ name: "Free", status: "ACTIVE" })).toBe(false);
    expect(
      isProSubscription({ name: "Something", status: "ACTIVE", lineItems: [{ plan: { pricingDetails: { price: { amount: "7.0" } } } }] }),
    ).toBe(true);
    expect(
      isProSubscription({ name: "Something", status: "ACTIVE", lineItems: [{ plan: { pricingDetails: { price: { amount: "0.0" } } } }] }),
    ).toBe(false);
  });

  it("derives the tier: test subscriptions count, inactive ones don't", () => {
    expect(tierFromSubscriptions([])).toBe("FREE");
    expect(tierFromSubscriptions([{ name: "Pro", status: "ACTIVE" }])).toBe("PRO");
    expect(tierFromSubscriptions([{ name: "Pro", status: "CANCELLED" }])).toBe("FREE");
    expect(tierFromSubscriptions([{ name: "Free", status: "ACTIVE" }])).toBe("FREE");
  });
});

// ---- routes ----
const state = vi.hoisted(() => ({ subs: [] as any[], plan: "FREE", cancelErrors: [] as unknown[], graphqlCalls: [] as string[] }));

vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn(), webhook: vi.fn() } }));
vi.mock("../app/services/shopData.server", () => ({
  ensureShop: vi.fn(async () => ({})),
  getPlan: vi.fn(async () => state.plan),
  setPlan: vi.fn(async (_s: string, p: string) => ((state.plan = p), p)),
}));
vi.mock("../app/services/jobs.server", () => ({ startJob: vi.fn(async () => {}) }));

const { authenticate } = await import("../app/shopify.server");
const plans = await import("../app/routes/app.plans");
const subWebhook = await import("../app/routes/webhooks.app_subscriptions.update");
const jobs = await import("../app/services/jobs.server");

const SHOP = "rev-store.myshopify.com";
const graphql = vi.fn(async (q: string) => {
  state.graphqlCalls.push(q);
  if (q.includes("appSubscriptionCancel")) {
    if (!state.cancelErrors.length) state.subs = [];
    return Response.json({ data: { appSubscriptionCancel: { userErrors: state.cancelErrors } } });
  }
  return Response.json({ data: { currentAppInstallation: { activeSubscriptions: state.subs } } });
});
const redirect = vi.fn((url: string, init: unknown) => new Response(null, { status: 302, headers: { Location: url, "X-Target": JSON.stringify(init) } }));

function post(intent: string) {
  const body = new FormData();
  body.set("intent", intent);
  return new Request("https://app.example/app/plans", { method: "POST", body });
}

beforeEach(() => {
  state.subs = [];
  state.plan = "FREE";
  state.cancelErrors = [];
  state.graphqlCalls = [];
  graphql.mockClear();
  redirect.mockClear();
  vi.mocked(jobs.startJob).mockClear();
  vi.mocked(authenticate.admin).mockResolvedValue({ session: { shop: SHOP }, admin: { graphql }, redirect } as any);
});

describe("plans page (managed pricing)", () => {
  it("Start trial sends the merchant to Shopify's hosted plan page at the top level", async () => {
    const res = (await plans.action({ request: post("upgrade"), params: {}, context: {} } as any)) as Response;
    expect(res.headers.get("Location")).toBe("https://admin.shopify.com/store/rev-store/charges/ordersheet-sync-1/pricing_plans");
    expect(redirect).toHaveBeenCalledWith(expect.any(String), { target: "_top" });
    expect(state.graphqlCalls.some((q) => q.includes("appSubscriptionCreate"))).toBe(false);
  });

  it("after a reinstall with no subscription the plan reads Free, and the trial can be requested again", async () => {
    state.plan = "PRO"; // stale cache from before the uninstall
    const data = await plans.loader({ request: new Request("https://app.example/app/plans"), params: {}, context: {} } as any);
    expect(data.plan).toBe("FREE");
    const res = (await plans.action({ request: post("upgrade"), params: {}, context: {} } as any)) as Response;
    expect(res.status).toBe(302);
  });

  it("an approved test (review store) subscription shows Pro", async () => {
    state.subs = [{ id: "gid://1", name: "Pro", status: "ACTIVE", test: true, trialDays: 7, currentPeriodEnd: null }];
    const data = await plans.loader({ request: new Request("https://app.example/app/plans"), params: {}, context: {} } as any);
    expect(data).toMatchObject({ plan: "PRO", test: true, trialDays: 7 });
  });

  it("declining leaves the shop on Free", async () => {
    state.subs = []; // merchant pressed Cancel on Shopify's page: no subscription is created
    const data = await plans.loader({ request: new Request("https://app.example/app/plans"), params: {}, context: {} } as any);
    expect(data.plan).toBe("FREE");
  });

  it("Downgrade to Free cancels the subscription", async () => {
    state.subs = [{ id: "gid://1", name: "Pro", status: "ACTIVE", test: false, trialDays: 0, currentPeriodEnd: null }];
    const out = await plans.action({ request: post("downgrade"), params: {}, context: {} } as any);
    expect(out).toMatchObject({ ok: true });
    expect(state.plan).toBe("FREE");
  });

  it("Downgrade falls back to Shopify's plan page if the API refuses the cancel", async () => {
    state.subs = [{ id: "gid://1", name: "Pro", status: "ACTIVE", test: false, trialDays: 0, currentPeriodEnd: null }];
    state.cancelErrors = [{ field: null, message: "nope" }];
    const res = (await plans.action({ request: post("downgrade"), params: {}, context: {} } as any)) as Response;
    expect(res.headers.get("Location")).toContain("/charges/ordersheet-sync-1/pricing_plans");
  });
});

describe("app_subscriptions/update webhook", () => {
  const call = () => subWebhook.action({ request: new Request("https://app.example/w", { method: "POST" }), params: {}, context: {} } as any);

  it("re-reads active subscriptions so a plan switch's CANCELLED event can't downgrade a Pro shop", async () => {
    state.subs = [{ id: "gid://2", name: "Pro", status: "ACTIVE", test: true }];
    vi.mocked(authenticate.webhook).mockResolvedValue({ shop: SHOP, admin: { graphql }, payload: { app_subscription: { name: "Pro", status: "CANCELLED" } } } as any);
    await call();
    expect(state.plan).toBe("PRO");
    expect(jobs.startJob).toHaveBeenCalled();
  });

  it("falls back to the payload without an offline session", async () => {
    state.plan = "PRO";
    vi.mocked(authenticate.webhook).mockResolvedValue({ shop: SHOP, admin: undefined, payload: { app_subscription: { name: "Pro", status: "CANCELLED" } } } as any);
    await call();
    expect(state.plan).toBe("FREE");
  });
});
