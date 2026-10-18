# Shopify App Store listing draft: OrderSheet Sync

> Shopify limits: app name ≤ 30 characters. The subtitle/tagline ("App card subtitle") ≤ 62. The introduction ≤ 100. Feature bullets ≤ 80 each. Keyword stuffing in the name is rejected, so keep keywords natural.

## App name (≤30)
**OrderSheet Sync: Sheets Export**  (30 chars)

Alternate: "OrderSheet: Google Sheets Sync" (30). Note the brand in code/README is "OrderSheet Sync"; the listing name can carry the keyword suffix.

## Subtitle / app card tagline (≤62)
**Auto-export Shopify orders to Google Sheets. Always in sync.**  (60)

## Search keywords (up to 5 terms in the Partner Dashboard)
google sheets · export orders · order export · spreadsheet sync · sales report

## Introduction (≤100)
Your orders in a Google Sheet that keeps itself up to date. One row per order, never duplicated.

## App details / description
OrderSheet Sync creates a Google Sheet of your Shopify orders and keeps it current, automatically. New orders appear within seconds. When an order is paid, refunded or fulfilled, its row updates in place, so you never get duplicate rows or stale numbers.

Set up in under a minute: connect Google, and your sheet is created and filled with your recent orders. No CSV downloads, no copy-paste, no formulas to maintain. Use it for daily sales reports, bookkeeping, fulfillment tracking, or sharing numbers with your accountant or team.

We only ask Google for access to the one spreadsheet we create. We can't see any other file in your Drive.

## Key features (3–5 bullets, ≤80 each)
- Real-time sync: new and updated orders land in your sheet in seconds
- Accurate: one row per order, updated in place. No duplicates, ever
- Pick columns: totals, tax, discounts, shipping, SKUs, line items, tags, more
- Filter by payment and fulfillment status, and backfill any date range
- Private by design: access to only the one sheet we create, nothing else

## Pricing text
**Free**: $0
- 1 Google Sheet
- Last 60 days of orders
- Daily automatic sync + "Sync now"
- 12 essential columns

**Pro**: $7/month · 7-day free trial
- Unlimited order history and custom date ranges
- Near real-time sync (seconds after each order)
- Choose your columns (SKUs, tags, sales channel and more)
- Payment and fulfillment status filters

All charges are billed in USD through Shopify and appear on your Shopify invoice.

## Privacy policy URL
`https://<your-host>/privacy` (served by the app from `app/lib/privacy.ts`).

## Privacy policy text
_(Same text as served at /privacy. Replace the bracketed placeholders before submitting.)_

### OrderSheet Sync – Privacy Policy
_Last updated: October 2026_

OrderSheet Sync ("the App") is provided by Pratik Poddar, an individual developer based in India ("we", "us"). This policy explains what information the App accesses when a merchant installs it on their Shopify store, and how we use, store and delete it.

**Information we access**
- **Shopify store information:** your shop domain, timezone, and an access token issued by Shopify so the App can read orders (read-only `read_orders` scope).
- **Order information:** order number, dates, payment and fulfillment status, amounts, currency, line items, SKUs, quantities, tags and sales channel. If you enable customer columns (only available once Shopify approves our protected customer data request), also customer name, email and shipping city/country.
- **Google account information:** your Google account email and an OAuth refresh token. We request only the `drive.file` scope, which lets the App access *only the spreadsheet it creates for you*. We cannot see, list or modify any other files in your Google Drive.
- **Billing status:** whether your store has an active subscription, as reported by Shopify. Payments are handled entirely by Shopify; we never see card details.

**How we use it**
Solely to provide the App: to write your orders into your Google Sheet and keep that sheet up to date, to show sync status, and to enforce your plan. We do not sell, rent or share your data, use it for advertising, or use it to train AI models.

**Where data is stored**
- Order data is written directly to the Google Sheet in **your** Google Drive. The App's own database does **not** store order contents or customer personal data.
- Our database stores: your shop domain and settings, sync logs (timestamps, row counts, error messages), the Shopify session token, and your Google refresh token encrypted with AES-256-GCM.
- Our servers are hosted by Netlify (application) and Supabase on AWS us-east-1 (database). Data is encrypted in transit (TLS).

**Sub-processors:** Shopify Inc. (platform and billing), Google LLC (Sheets/Drive API), Netlify, Inc. and Supabase, Inc. (hosting and database).

**Retention and deletion**
- Disconnecting Google revokes and deletes the Google token immediately.
- Uninstalling the App revokes the Google token and deletes all data we hold for your store. The spreadsheet remains in your Google Drive and belongs to you.
- We honour Shopify's mandatory privacy webhooks: `customers/data_request`, `customers/redact` (we also blank customer cells for the affected orders in your sheet when customer columns are enabled) and `shop/redact`.

**Your rights**
Merchants and their customers may request access to, correction of, or deletion of personal information by contacting pratik.phodu@gmail.com. Customer requests are handled together with the merchant, who controls their order data. EEA/UK residents may also complain to their local data protection authority.

**Google API Services User Data Policy**
OrderSheet Sync's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

**Changes and contact**
We will post changes on this page and update the date above. Questions: pratik.phodu@gmail.com.

## Screenshot ideas (1600×900, 3+ required)
1. **"Your orders, live in Google Sheets"**: split view. Left: the app dashboard (Connected as you@gmail.com · 1,284 orders · Last sync 2 min ago · green "success" log rows). Right: the Google Sheet with neat columns (Order, Created at, Payment status, Total, Line items) and a highlighted row labelled "updated 3s ago".
2. **"Pick exactly the columns you need"**: the Settings page with column checkboxes (SKUs, Tags, Source ticked), the backfill date range, and payment/fulfillment filters. Callout: "No duplicates: each order stays on one row."
3. **"Free to start. $7 when you grow"**: the Plans page showing Free vs Pro side by side, the "7-day free trial" button, and a competitor-free value line: "Real-time sync for less than a coffee a week."
4. (Optional) **"Private by design"**: Google's consent screen showing only "See, edit, create, and delete only the specific Google Drive files you use with this app", with the caption "We can only see the sheet we create."

## Demo screencast outline (required by review, 1–3 min)
Install on the dev store → Connect Google (consent shows only drive.file) → the sheet fills → edit an order in Shopify → the row updates in place → Settings: add SKUs → Rebuild → Plans: start the trial → Uninstall.

## Reviewer instructions (paste into "Testing instructions")
1. Install the app on the provided dev store. 2. Click **Connect Google** and sign in with any Google account. 3. Open the created sheet from the dashboard; the last 60 days of orders are there. 4. Click **Sync now**; the sync log shows a new entry. 5. Go to **Plans → Start 7-day free trial** (test charge) to see Pro features: custom columns, filters and real-time sync. Edit any order and its row updates within seconds.
