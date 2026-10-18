/**
 * Privacy policy served at /privacy. Keep in sync with LISTING.md.
 * Privacy policy text.
 */
export const PRIVACY_POLICY_HTML = `
<h1>OrderSheet Sync – Privacy Policy</h1>
<p><em>Last updated: October 2026</em></p>
<p>OrderSheet Sync ("the App") is provided by Pratik Poddar, an individual developer based in India ("we", "us"). This policy explains what information the App accesses when a merchant installs it on their Shopify store, and how we use, store and delete it.</p>

<h2>Information we access</h2>
<ul>
<li><strong>Shopify store information:</strong> your shop domain, timezone, and an access token issued by Shopify so the App can read orders (read-only <code>read_orders</code> scope).</li>
<li><strong>Order information:</strong> order number, dates, payment and fulfillment status, amounts, currency, line items, SKUs, quantities, tags and sales channel. If you enable customer columns (only available once Shopify approves our protected customer data request), also customer name, email and shipping city/country.</li>
<li><strong>Google account information:</strong> your Google account email and an OAuth refresh token. We request only the <code>drive.file</code> scope, which lets the App access <em>only the spreadsheet it creates for you</em>. We cannot see, list or modify any other files in your Google Drive.</li>
<li><strong>Billing status:</strong> whether your store has an active OrderSheet Sync subscription, as reported by Shopify. Payments are handled entirely by Shopify; we never see card details.</li>
</ul>

<h2>How we use it</h2>
<p>Solely to provide the App: to write your orders into your Google Sheet and keep that sheet up to date, to show sync status, and to enforce your plan. We do not sell, rent or share your data, use it for advertising, or use it to train AI models.</p>

<h2>Where data is stored</h2>
<ul>
<li>Order data is written directly to the Google Sheet in <strong>your</strong> Google Drive. The App's own database does <strong>not</strong> store order contents or customer personal data.</li>
<li>Our database stores: your shop domain and settings, sync logs (timestamps, row counts, error messages), the Shopify session token, and your Google refresh token encrypted with AES-256-GCM.</li>
<li>Our servers are hosted by Netlify (application) and Supabase on AWS us-east-1 (database). Data is encrypted in transit (TLS).</li>
</ul>

<h2>Sub-processors</h2>
<ul>
<li>Shopify Inc. (store platform and billing)</li>
<li>Google LLC (Google Sheets / Drive API)</li>
<li>Netlify, Inc. and Supabase, Inc. (application hosting and database)</li>
</ul>

<h2>Retention and deletion</h2>
<ul>
<li>When you disconnect Google, we revoke and delete the Google token immediately.</li>
<li>When you uninstall the App, we revoke the Google token and delete all data we hold for your store (settings, logs, tokens). The spreadsheet remains in your Google Drive and belongs to you.</li>
<li>We honour Shopify's mandatory privacy webhooks: <code>customers/data_request</code>, <code>customers/redact</code> (we also blank customer cells for the affected orders in your sheet when customer columns are enabled) and <code>shop/redact</code>.</li>
</ul>

<h2>Your rights</h2>
<p>Merchants and their customers may request access to, correction of, or deletion of personal information by contacting us at pratik.phodu@gmail.com. Requests from customers of a store are handled together with the merchant, who controls their order data. If you are in the EEA/UK, you may also complain to your local data protection authority.</p>

<h2>Google API Services User Data Policy</h2>
<p>OrderSheet Sync's use and transfer of information received from Google APIs adheres to the <a href="https://developers.google.com/terms/api-services-user-data-policy">Google API Services User Data Policy</a>, including the Limited Use requirements.</p>

<h2>Changes and contact</h2>
<p>We will post changes to this page and update the date above. Questions: pratik.phodu@gmail.com.</p>
`;
