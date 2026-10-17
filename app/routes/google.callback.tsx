import type { LoaderFunctionArgs } from "react-router";
import { config } from "../config.server";
import { verifyState } from "../lib/crypto.server";
import { exchangeCodeAndStore } from "../services/google.server";
import { ensureShop, getOrCreateConfig } from "../services/shopData.server";
import { runJobChunk, startJob } from "../services/jobs.server";

/**
 * Google redirects here (top-level tab, outside the Shopify iframe).
 * The signed `state` identifies the shop; no Shopify session is needed.
 */
const page = (title: string, body: string, link?: string) =>
  new Response(
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:Inter,system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 24px;color:#303030}a{color:#005bd3}</style></head>
<body><h1>${title}</h1><p>${body}</p>${link ? `<p><a href="${link}">Back to OrderSheet Sync</a></p>` : ""}
<script>try{window.opener&&window.opener.focus()}catch(e){}</script></body></html>`,
    { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } },
  );

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);
  const state = verifyState(url.searchParams.get("state") || "");
  if (!state) return page("Link expired", "This connection link is invalid or expired. Please click Connect Google again in the app.");
  const adminLink = `https://admin.shopify.com/store/${state.shop.replace(".myshopify.com", "")}/apps/${config.apiKey()}`;

  const err = url.searchParams.get("error");
  if (err) return page("Google not connected", `Google returned: ${escape(err)}. You can close this tab and try again.`, adminLink);

  const code = url.searchParams.get("code");
  if (!code) return page("Google not connected", "No authorisation code was returned.", adminLink);

  try {
    await ensureShop(state.shop);
    await getOrCreateConfig(state.shop);
    const { email } = await exchangeCodeAndStore(state.shop, code);
    // Record the backfill, then create the sheet and import the first pages right away
    // (bounded); the dashboard and the scheduled function continue from the saved cursor.
    await startJob(state.shop, "BACKFILL", { replace: true });
    await runJobChunk(state.shop, config.budgets.callbackMs()).catch((e) => console.error("[google] first chunk failed", e));
    return page(
      "Google connected",
      `Connected${email ? ` as ${escape(email)}` : ""}. We're creating your sheet and importing orders now. You can close this tab.`,
      adminLink,
    );
  } catch (e) {
    return page("Google not connected", escape((e as Error).message), adminLink);
  }
};
