import { PRIVACY_POLICY_HTML } from "../lib/privacy";

/** Public privacy policy URL for the App Store listing: <SHOPIFY_APP_URL>/privacy */
export const loader = () =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OrderSheet Sync – Privacy Policy</title>
<style>body{font-family:Inter,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 24px;line-height:1.55;color:#303030}</style></head><body>${PRIVACY_POLICY_HTML}</body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
