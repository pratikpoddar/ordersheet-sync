/** Centralised env access so missing config fails loudly and in one place. */
const bool = (v: string | undefined, d = false) =>
  v === undefined || v === "" ? d : ["1", "true", "yes", "on"].includes(v.toLowerCase());

export const config = {
  appUrl: () => process.env.SHOPIFY_APP_URL || "",
  apiKey: () => process.env.SHOPIFY_API_KEY || "",
  googleClientId: () => required("GOOGLE_CLIENT_ID"),
  googleClientSecret: () => required("GOOGLE_CLIENT_SECRET"),
  /** Redirect URI registered in Google Cloud: <SHOPIFY_APP_URL>/google/callback */
  googleRedirectUri: () =>
    process.env.GOOGLE_REDIRECT_URI || `${process.env.SHOPIFY_APP_URL || ""}/google/callback`,
  /**
   * OFF by default. Turn on only after Shopify approves Protected Customer Data
   * (Level 2: name, email, address) for this app in the Partner Dashboard.
   */
  protectedCustomerData: () => bool(process.env.PROTECTED_CUSTOMER_DATA_ENABLED, false),
  /**
   * Billing test charges. BILLING_TEST=true forces test charges for every shop.
   * Otherwise development/sandbox stores (incl. Shopify reviewers' stores) get test
   * charges and real stores get real charges.
   */
  billingTest: (isDevStore = false) =>
    bool(process.env.BILLING_TEST, process.env.NODE_ENV !== "production") || isDevStore,
  /**
   * Time budgets (ms) for serverless work units. Netlify: synchronous functions 60s,
   * scheduled functions 30s. Shopify wants a webhook response within 5s.
   */
  budgets: {
    /** Scheduled function (netlify/functions/reconcile.ts); hard platform limit 30s. */
    scheduledMs: () => int(process.env.SCHEDULED_BUDGET_MS, 25_000, 5_000, 27_000),
    /** "Sync now" / "Rebuild" action: one chunk inside the 60s request. */
    manualMs: () => int(process.env.MANUAL_CHUNK_BUDGET_MS, 40_000, 5_000, 50_000),
    /** Dashboard poll that keeps a running job moving while the merchant watches. */
    continueMs: () => int(process.env.CONTINUE_CHUNK_BUDGET_MS, 20_000, 5_000, 50_000),
    /** Google OAuth callback: creates the sheet and imports the first pages. */
    callbackMs: () => int(process.env.CALLBACK_CHUNK_BUDGET_MS, 20_000, 5_000, 50_000),
    /** Inline webhook upsert before we answer Shopify anyway (Shopify times out at 5s). */
    webhookInlineMs: () => int(process.env.WEBHOOK_INLINE_TIMEOUT_MS, 4_000, 1_000, 50_000),
    /** How long a deferred webhook upsert may keep running after the response (Netlify waitUntil). */
    webhookTailMs: () => int(process.env.WEBHOOK_TAIL_MS, 20_000, 0, 50_000),
  },
};

function int(v: string | undefined, d: number, min: number, max: number): number {
  const n = Number(v);
  if (!v || !Number.isFinite(n)) return d;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}
