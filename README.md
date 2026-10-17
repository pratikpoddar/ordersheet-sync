# OrderSheet Sync

A Shopify embedded app that exports a store's orders to a Google Sheet and keeps it in sync.
Target price: **Free** + **Pro $7/mo** (7-day trial).

The pitch against Exportsy ($19.99), eCommix ($9.99) and Matrixify ($20): **reliable, accurate sync**, a **simple UI**, and **real value before the paywall**.

---

## Architecture

```
Shopify Admin (iframe)                         Google
  │  App Bridge + Polaris web components         ▲  OAuth 2.0 (openid, email, drive.file)
  ▼                                              │  Sheets API v4 (REST via fetch)
React Router app (Node 22, TypeScript)  ─────────┘
  on Netlify Functions (one SSR function for every route) + Supabase Postgres
  ├─ app/routes/app._index.tsx      Dashboard: connect Google, sheet link, status, Sync now, Rebuild, sync log
  ├─ app/routes/app.settings.tsx    Columns, backfill date range, status filters (saved through the plan gate)
  ├─ app/routes/app.plans.tsx       Billing API: billing.check / billing.request / billing.cancel
  ├─ app/routes/google.callback.tsx Google OAuth redirect (top-level tab, signed `state`)
  ├─ app/routes/webhooks.*.tsx      orders/create+updated, app_subscriptions/update, app/uninstalled,
  │                                 customers/data_request, customers/redact, shop/redact
  ├─ app/routes/privacy.tsx         Public privacy policy (URL for the listing)
  │
  ├─ app/services/sync.server.ts        Sheet session, DB lease, prepare/clear sheet, logs, redact
  ├─ app/services/jobs.server.ts        Resumable sync jobs: startJob() + runJobChunk() in bounded chunks
  ├─ app/services/webhookSync.server.ts Inline webhook upsert, DirtyOrder / PendingRedaction queues
  ├─ app/services/shopifyOrders.server.ts GraphQL Admin API: cursor pagination, throttle handling, retries
  ├─ app/services/google.server.ts      OAuth, encrypted refresh tokens, Sheets calls with backoff
  ├─ app/services/scheduler.server.ts   runScheduledSweep(): one 25s pass over due shops and running jobs
  ├─ netlify/functions/reconcile.ts     Netlify scheduled function, every 15 min → runScheduledSweep()
  ├─ app/services/shopData.server.ts    Plan cache, settings, purge on uninstall/redact
  │
  └─ app/lib/  (pure, unit-tested)
       columns.ts     fixed column catalogue, protected-data flag handling
       normalize.ts   GraphQL node + webhook payload → one NormalizedOrder shape
       rowMapping.ts  NormalizedOrder → sheet row (formula-injection safe, shop timezone dates)
       upsert.ts      planUpsert(): id column + rows → updates / appends / deletes
       plans.ts       Free/Pro entitlements + server-side sanitizeSettings()
       filters.ts     Shopify search query builder + local filter check
       retry.ts       withRetry() exponential backoff with jitter + Retry-After
       crypto.server.ts AES-256-GCM token encryption, HMAC-signed OAuth state
       schedule.ts    when a shop's reconciliation is due
       jobs.ts        deadline, timeout guard, resumable paged chunk runner, sweep planning
Prisma (Postgres/Supabase; optional SQLite for local dev):
  Session, Shop, GoogleConnection, SyncConfig (+ job cursor/progress), DirtyOrder, PendingRedaction, SyncLog
```

### How the sync stays accurate

1. **One row per order, keyed by order ID.** Column A is always the Shopify order ID (written as text). Before writing, the engine reads column A and `planUpsert()` decides, per order, *update this row in place* or *append*. Replaying the same batch never adds rows. If a merchant sorts the sheet, IDs still match because the key is read from the sheet, not remembered.
2. **Self-healing duplicates.** If an ID already appears twice (e.g. the merchant pasted rows), the extra rows are deleted, bottom-up, so row numbers never shift mid-write.
3. **Webhooks are re-fetched.** `orders/create` and `orders/updated` verify the HMAC, then fetch the *current* order from the GraphQL API and upsert its row inline, so out-of-order or duplicate webhook delivery can't write stale data. The inline work has a timeout guard (4s by default, because Shopify expects an answer within 5s). On timeout, error, or a busy sheet, the order goes into `DirtyOrder` and the scheduled function writes it. The webhook always answers 200.
4. **Serialised per shop.** A DB lease (`SyncConfig.lockedUntil` + `leaseOwner`) makes sure only one invocation writes a sheet at a time. Leases expire on their own, so a killed function never blocks a shop for long.
5. **Reconciliation safety net.** A Netlify scheduled function runs every 15 min. Each shop is reconciled when due (Pro hourly, Free daily). Reconciliation is incremental: orders `updated_at >= last success − 2h`. Status filters are applied locally, so an order that stops matching (for example, it gets refunded while you filter on "paid") is removed from the sheet.
6. **Resumable jobs (serverless).** Backfills, rebuilds and reconciles are jobs stored on `SyncConfig` (`jobId`, `jobPhase`, `jobCursor`, `jobParams`, progress counters). Each invocation runs one bounded chunk. It writes 40 orders per page, saves the Shopify cursor after every page, and stops before its time budget runs out. The next invocation continues from the saved cursor: the "Sync now"/"Rebuild" request itself (~40s), the open dashboard (~20s chunks), the Google callback, or the scheduled function (~25s). A page replayed after a crash is harmless because writes are upserts. Starting a new job (for example Rebuild, or a settings change) replaces the old one, and the old chunk stops at its next save.
7. **Retries everywhere.** Google 429/5xx and Shopify `THROTTLED`/5xx retry with exponential backoff and jitter, and honour `Retry-After`. The engine also watches Shopify's leaky bucket (`throttleStatus`) and pauses before the bucket runs dry.
8. **No truncation.** Orders are fetched 40 per page with 20 line items each, which stays under the 1,000-point query cost. Orders with more line items get the rest fetched with a follow-up query.
9. **Spreadsheet-safe values.** Text starting with `= + - @` gets an apostrophe in front, which blocks formula injection from tags or product titles. Money goes in as numbers and dates as real date-times in the shop's timezone.
10. **Visible state.** The dashboard reads everything from the DB: live job progress (pages read, rows written, last progress time), last success time, row count, last error, and the latest 15 log entries (200 kept per shop). A failing chunk is retried twice from its cursor before the job is marked failed.

### Plans (enforced server-side)

| | Free | Pro ($7/mo, 7-day trial) |
|---|---|---|
| Sheets | 1 | 1 |
| History | last 60 days (rolling) | unlimited, any date range |
| Sync | daily + manual "Sync now" | near real-time (webhooks) + hourly reconcile |
| Columns | 12 defaults | any from the catalogue |
| Filters | none | payment / fulfillment status, test, cancelled |

`sanitizeSettings()` re-applies the current plan on every save **and** every sync. A downgrade automatically falls back to Free settings (the sheet is rebuilt), and posting Pro fields from the browser does nothing. Webhook sync is skipped for Free shops. The plan is cached in `Shop.plan`. It is refreshed from `billing.check` on every admin page load, from the `app_subscriptions/update` webhook, and by the scheduled function every 6h.

> Design choice: the app uses `billing.check` + `billing.request` rather than a blanket `billing.require`, because the Free plan must work without any charge approval ("value before paywall"). Pro features are clamped server-side instead of redirecting free users to a charge screen.

### Protected customer data

The `read_orders` scope alone already requires a **Protected Customer Data request (Level 1)** in the Partner Dashboard, since orders are customer data. **Customer name, customer email, shipping city and shipping country need Level 2 approval** (name, email, address fields). Those four columns stay hidden, and are never queried from GraphQL, until you set `PROTECTED_CUSTOMER_DATA_ENABLED=true`. Only do that after Shopify approves Level 2. I gated the shipping city/country columns too, because Shopify classes them as address fields.

---

## Environment variables

Set these in Netlify (**Site configuration → Environment variables**) for production, and in `.env` for local dev (`.env.example` lists them all). Never commit real values.

| Var | Required | Notes |
|---|---|---|
| `SHOPIFY_API_KEY` | yes | Client ID from the Partner Dashboard (`53fa8597a5e194cd86625190a18dcc1a`) |
| `SHOPIFY_API_SECRET` | yes | Client secret. Also used to sign the Google OAuth `state` |
| `SHOPIFY_APP_URL` | yes | `https://ordersheet-sync.netlify.app` (site name TBC; the CLI sets a tunnel URL in dev) |
| `SCOPES` | yes | `read_orders` |
| `DATABASE_URL` | yes | Supabase **transaction pooler**, port **6543**, with `?pgbouncer=true&connection_limit=1`. Used at runtime |
| `DIRECT_URL` | yes | Supabase **session pooler or direct connection**, port **5432**. Used only by `prisma migrate` (`npm run db:deploy`) |
| `GOOGLE_CLIENT_ID` | yes | Google OAuth client (Web application) |
| `GOOGLE_CLIENT_SECRET` | yes | |
| `ENCRYPTION_KEY` | yes | 32 bytes, hex or base64: `openssl rand -hex 32`. **Never rotate without re-encrypting**, or stored tokens become unreadable |
| `BILLING_TEST` | no | Test charges. Defaults to `true` unless `NODE_ENV=production`. Set `false` for the live listing |
| `PROTECTED_CUSTOMER_DATA_ENABLED` | no | `false` by default |
| `GOOGLE_REDIRECT_URI` | no | Defaults to `${SHOPIFY_APP_URL}/google/callback` |
| `SCHEDULED_BUDGET_MS`, `MANUAL_CHUNK_BUDGET_MS`, `CONTINUE_CHUNK_BUDGET_MS`, `CALLBACK_CHUNK_BUDGET_MS`, `WEBHOOK_INLINE_TIMEOUT_MS`, `WEBHOOK_TAIL_MS` | no | Time budgets in ms. Defaults: 25000 / 40000 / 20000 / 20000 / 4000 / 20000, clamped to safe ranges |

`RECONCILE_CRON` and `DISABLE_CRON` are gone. The schedule now lives in `netlify/functions/reconcile.ts` (`*/15 * * * *`).

## Database: Supabase Postgres (production), SQLite optional locally

- `prisma/schema.prisma` is **Postgres** and is the default schema: `prisma generate` and `prisma migrate` use it with no flags. `url = env("DATABASE_URL")` (pooled, port 6543) and `directUrl = env("DIRECT_URL")` (port 5432, for migrations). `binaryTargets` includes `rhel-openssl-3.0.x` for Netlify Functions. Migrations live in `prisma/migrations/` (`0001_init`, `0002_serverless_jobs`).
- `prisma/sqlite/schema.prisma` has the same models on SQLite, with its own migrations in `prisma/sqlite/migrations/`, for quick local dev with `DATABASE_URL=file:dev.sqlite`.
- `npm run setup` (`scripts/db-setup.mjs`) picks the schema from `DATABASE_URL`, generates the client and runs `migrate deploy`. For a local Postgres it defaults `DIRECT_URL` to `DATABASE_URL`.
- **Why both URLs:** serverless functions open many short-lived connections, so the app connects through Supavisor in transaction mode (`pgbouncer=true` turns off prepared statements, and `connection_limit=1` means one connection per function instance). `prisma migrate` needs a session-mode connection, hence `DIRECT_URL`.
- **Session storage:** Shopify sessions use `PrismaSessionStorage` through a small wrapper (`app/sessionStorage.server.ts`). If the cold-start table check fails once (for example while the pooler wakes up), the wrapper retries instead of breaking a warm instance for good.
- **Changing models:** edit **both** schemas. Create the Postgres migration with `npx prisma migrate dev --create-only --name <change>` against a dev Postgres, or offline with `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url <dev-pg> --script`. Create the SQLite one with `DATABASE_URL=file:dev.sqlite npx prisma migrate dev --schema prisma/sqlite/schema.prisma --name <change>`.

## Local development

Prerequisites: Node 22.12+, a Shopify Partner account + dev store, a Google Cloud OAuth client (see the checklist below).

```bash
npm install
cp .env.example .env            # fill GOOGLE_*, ENCRYPTION_KEY; DATABASE_URL = a dev Postgres (or a Supabase
                                # dev project / branch) or file:dev.sqlite
npm run setup                   # generate Prisma client + migrate (Postgres or SQLite by DATABASE_URL)
npm test                        # unit tests (vitest)
TEST_DATABASE_URL=postgresql://… npm run test:db   # optional: job runner against a real, throwaway Postgres
npm run typecheck
shopify app config link         # links shopify.app.toml to your Partner app (fills client_id)
shopify app dev                 # tunnel + installs on your dev store; sets SHOPIFY_APP_URL/API key/secret
```

During `shopify app dev`, the tunnel URL changes each run. Add `https://<tunnel>/google/callback` to the Google OAuth client's **Authorized redirect URIs**, or use a fixed tunnel (`shopify app dev --tunnel-url`) or a stable ngrok/Cloudflare domain so you only add it once.

Locally there is no scheduled function. Jobs still move forward while the dashboard is open (it advances them in ~20s chunks). To run one sweep by hand: `npx netlify functions:invoke reconcile` with `netlify dev`, or call `runScheduledSweep()` from a script.

To test webhooks: `shopify app webhook trigger --topic orders/updated --address <tunnel>/webhooks/orders`. Real webhooks fire when you create or edit orders in the dev store (use the Bogus Gateway for test orders, and turn on "Include test orders" in Settings, which is a Pro filter. On a dev store the test charge is free).

---

## Deploy: Netlify + Supabase

The app is fully serverless: no always-on instance, no in-memory state. Netlify limits it is built around: synchronous functions 60s, scheduled functions 30s (cron, no payload, published deploys only). **No background functions are used**, so it works on the free plan.

| Piece | Where | Budget |
|---|---|---|
| Every route (`/app/*`, `/auth/*`, `/webhooks/*`, `/privacy`, `/google/callback`) | `.netlify/v1/functions/react-router-server.mjs`, generated by `@netlify/vite-plugin-react-router` at build | 60s per request |
| Reconciliation sweep | `netlify/functions/reconcile.ts`, `schedule: "*/15 * * * *"` | stops itself at 25s (limit 30s) |
| Sync now / Rebuild | records the job, runs one chunk | ~40s |
| Order webhooks | HMAC check + inline upsert | 4s guard, then deferred to `DirtyOrder` (Netlify `waitUntil` lets it finish if it can) |

### 1. Supabase
1. Create a project (pick a region near Netlify's function region, US East by default).
2. **Project Settings → Database → Connection string**:
   - **Transaction pooler** (port 6543) → `DATABASE_URL`, and add `?pgbouncer=true&connection_limit=1`
   - **Session pooler** (port 5432) or the direct connection → `DIRECT_URL`
3. Apply the schema from your machine:
   ```bash
   DATABASE_URL="…6543/postgres?pgbouncer=true&connection_limit=1" DIRECT_URL="…5432/postgres" npm run db:deploy
   ```
   Re-run `npm run db:deploy` whenever a new migration is added, **before** deploying the code that needs it. The Netlify build does not run migrations, so deploy previews never touch the production schema.

### 2. Netlify
1. Push the repo to GitHub. **Add new site → Import from Git**. `netlify.toml` provides the build command (`npx prisma generate && npm run build`), the publish dir (`build/client`) and Node 22.
2. Name the site `ordersheet-sync` (or another name, then use that URL everywhere below).
3. **Site configuration → Environment variables**: add every variable from the table above (`BILLING_TEST=false` for the live listing).
4. Deploy. Check **Logs → Functions**: you should see `React Router server handler` and `reconcile` (Scheduled). Scheduled functions only run on the **published** production deploy.

### 3. Shopify + Google
```bash
# shopify.app.toml already points at https://ordersheet-sync.netlify.app (+ /auth/callback).
# Change both if the site name differs, then:
shopify app deploy        # pushes config, scopes and webhook subscriptions (incl. compliance topics)
```
Then add `https://<site>.netlify.app/google/callback` to the Google OAuth client's redirect URIs.

`render.yaml`, `fly.toml` and the `Dockerfile` were removed. They belonged to the old always-on design (in-process cron + webhook queue).

---

## What Pratik must do (step by step)

These steps need your own accounts. Nothing here can be done from the code.

**1. Shopify Partner account**
- [ ] Sign up at https://partners.shopify.com (free). Fill the business profile and payout details (needed for app revenue).

**2. Development store**
- [ ] Partner Dashboard → **Stores → Add store → Development store**. Add 20–50 test orders (Settings → Payments → Bogus Gateway, or use a sample-data app) with a mix of paid, refunded, fulfilled and multi-line orders.

**3. Create the app**
- [ ] Partner Dashboard → **Apps → Create app → Create app manually**, name it "OrderSheet Sync". Copy **Client ID** → `SHOPIFY_API_KEY` and **Client secret** → `SHOPIFY_API_SECRET`.
- [ ] Locally: `npm install`, then `shopify app config link` and choose this app.
- [ ] **API access → Protected customer data access → Request access**. Pick Level 1 (needed for orders) and explain the purpose: "export the merchant's own orders to their Google Sheet". Leave Level 2 (name, email, address) for later, or request it now if you want the customer columns. Then flip `PROTECTED_CUSTOMER_DATA_ENABLED=true` once approved.

**4. Google Cloud project + OAuth consent screen**
- [ ] https://console.cloud.google.com → New project "OrderSheet Sync".
- [ ] **APIs & Services → Library**: enable **Google Sheets API** and **Google Drive API**.
- [ ] **OAuth consent screen** (Google Auth Platform): User type **External**. App name, support email, logo, **app home page** (your landing page), **privacy policy** `https://<host>/privacy`, **authorized domain** = your host's domain (verify it in Search Console if asked).
- [ ] **Data access / Scopes**: add only `openid`, `.../auth/userinfo.email`, `.../auth/drive.file`. All three are non-sensitive, so you skip the restricted-scope security assessment.
- [ ] **Credentials → Create OAuth client ID → Web application**. Authorized redirect URI: `https://<host>/google/callback` (plus your dev tunnel URL). Copy the ID and secret → `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`.
- [ ] While "Testing", add your Google account as a test user. Before launch, click **Publish app → In production**. With non-sensitive scopes, Google may still ask for brand verification (name, logo, domain). That usually takes a few days, not the weeks a sensitive-scope review takes.

**5. Run it locally**
- [ ] `cp .env.example .env`, fill values, set `ENCRYPTION_KEY=$(openssl rand -hex 32)`, then run `npm run setup` and `shopify app dev`.
- [ ] Install on the dev store → Connect Google → confirm the sheet appears with your orders.

**6. Host it (Netlify + Supabase, see Deploy)**
- [ ] Create the Supabase project, copy the 6543 (pooled) and 5432 (direct/session) connection strings, and run `npm run db:deploy`.
- [ ] Create the Netlify site, confirm the site name, set every env var (`BILLING_TEST=false`) and deploy.
- [ ] If the site isn't `ordersheet-sync.netlify.app`, update `shopify.app.toml` URLs. Run `shopify app deploy` and add the production Google redirect URI.

**7. Test before submitting** (Shopify reviewers do all of these)
- [ ] Fresh install from the Partner Dashboard "Test on development store" → OAuth works → app loads inside Admin with no errors.
- [ ] Connect Google, see the backfill progress on the dashboard, use Sync now, and check the log shows rows. On a store with a few thousand orders, close the dashboard mid-backfill and confirm the scheduled function finishes it (Netlify function logs show `[reconcile]`).
- [ ] Edit an order on Pro: the row updates within seconds and no duplicate appears. Refund it while filtering on "Paid": the row disappears.
- [ ] Upgrade (test charge) → trial shown → Pro features unlock. Cancel → back to Free and the sheet is rebuilt with default columns.
- [ ] Uninstall → DB rows for the shop are gone. Reinstall works cleanly.
- [ ] Trigger compliance webhooks: `shopify app webhook trigger --topic customers/data_request` (and `customers/redact`, `shop/redact`) → each returns 200.
- [ ] Revoke the app at https://myaccount.google.com/permissions → the next sync shows "Please reconnect Google".

**8. Submit**
- [ ] Partner Dashboard → App → **Distribution → Public (App Store)**.
- [ ] Fill the listing from `LISTING.md`: name, subtitle, intro, features, pricing (Free + Pro $7/30 days, 7-day trial), 3+ screenshots at 1600×900, a 1200×1200 icon, a demo screencast (required: show install, connect Google, sheet updating), privacy policy URL, support email, and test-store instructions for reviewers.
- [ ] Pricing in the listing **must match** the Billing API config (`app/shopify.server.ts`).
- [ ] Submit and answer reviewer feedback. First reviews usually take a few business days to a couple of weeks.

---

## Scripts

| Script | |
|---|---|
| `npm run dev` | `shopify app dev` |
| `npm run build` | production build (Netlify runs `npx prisma generate && npm run build`) |
| `npm start` | serve the build locally with `react-router-serve` (no scheduler; for smoke tests only) |
| `npm run setup` | local: generate Prisma client + migrate (Postgres or SQLite by `DATABASE_URL`) |
| `npm run db:deploy` | `prisma migrate deploy` on the Postgres schema (uses `DIRECT_URL`) |
| `npm run db:status` | `prisma migrate status` |
| `npm test` | vitest unit tests (the DB integration test is skipped unless `TEST_DATABASE_URL` is set) |
| `npm run test:db` | job runner integration test against a throwaway Postgres (wipes its tables) |
| `npm run typecheck` | React Router typegen + `tsc --noEmit` |

## Known gaps / next steps

- **Large stores:** backfill pages through the GraphQL connection, which is fine up to tens of thousands of orders. For 100k+ orders, switch the full backfill to `bulkOperationRunQuery` (JSONL) and write in larger batches. Sheets also caps at 10M cells (roughly 500k rows at 19 columns).
- **Serverless throughput:** the scheduled function does at most ~25s of work every 15 min. On average that is about 10–15 pages (400–600 orders) per run, shared across shops. With the dashboard closed, a 100k-order backfill takes many hours. With it open, it moves at ~20s chunks back-to-back. With many shops, consider a paid plan's background functions or an external worker (the job runner is already chunked and resumable, so either can call `runJobChunk`).
- **Webhook latency:** inline upserts that exceed the 4s guard (slow Google/Shopify) are finished by `waitUntil` when possible. Otherwise they are written by the next scheduled run (up to 15 min later, Pro only).
- **Column changes rebuild the sheet** (clear + rewrite). Merchant-added columns to the right of the export are cleared on rebuild. Document this in the app's help text, or write into a dedicated tab.
- **Totals are as originally placed** (`totalPriceSet`). Add "current total / refunded amount" columns if merchants ask.
- No integration tests against live Shopify or Google APIs. Only the pure logic is unit-tested. Run the step 7 checklist on a dev store.
- Only one sheet per shop. A "pick an existing sheet" option would need the Google Picker (which still works with `drive.file`).
