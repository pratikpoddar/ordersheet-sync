import db from "../db.server";
import { config } from "../config.server";
import { decrypt, encrypt, signState } from "../lib/crypto.server";
import { HttpError, withRetry } from "../lib/retry";
import type { Cell } from "../lib/rowMapping";

/**
 * Non-sensitive scopes only. `drive.file` grants access solely to files this app
 * creates (or the user explicitly opens with it), so it avoids Google's
 * restricted-scope security assessment.
 */
export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/drive.file",
];

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SHEETS = "https://sheets.googleapis.com/v4/spreadsheets";

export class GoogleAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAuthError";
  }
}

/* ---------------------------- OAuth ---------------------------- */

export function buildGoogleAuthUrl(shop: string): string {
  const params = new URLSearchParams({
    client_id: config.googleClientId(),
    redirect_uri: config.googleRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent", // guarantees a refresh_token on every connect
    include_granted_scopes: "true",
    state: signState({ shop }),
  });
  return `${AUTH_URL}?${params}`;
}

function decodeJwtEmail(idToken?: string): string | null {
  if (!idToken) return null;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : null;
  } catch {
    return null;
  }
}

export async function exchangeCodeAndStore(shop: string, code: string) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.googleClientId(),
      client_secret: config.googleClientSecret(),
      redirect_uri: config.googleRedirectUri(),
      grant_type: "authorization_code",
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleAuthError(json.error_description || json.error || `Token exchange failed (${res.status})`);
  if (!json.refresh_token) throw new GoogleAuthError("Google did not return a refresh token. Please try connecting again.");
  const granted: string = json.scope || "";
  if (!granted.includes("https://www.googleapis.com/auth/drive.file")) {
    throw new GoogleAuthError("Please allow access to files created by OrderSheet Sync (the Drive checkbox) and try again.");
  }

  const email = decodeJwtEmail(json.id_token);
  const data = { email, encryptedRefreshToken: encrypt(json.refresh_token), scope: granted };
  await db.googleConnection.upsert({ where: { shop }, create: { shop, ...data }, update: data });
  accessTokenCache.delete(shop);
  return { email };
}

/* Short-lived access tokens are cached in memory only (never persisted). */
const accessTokenCache = new Map<string, { token: string; expiresAt: number }>();

export async function getAccessToken(shop: string): Promise<string> {
  const cached = accessTokenCache.get(shop);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const conn = await db.googleConnection.findUnique({ where: { shop } });
  if (!conn) throw new GoogleAuthError("Google account is not connected.");
  const refreshToken = decrypt(conn.encryptedRefreshToken);

  const json: any = await withRetry(async () => {
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.googleClientId(),
        client_secret: config.googleClientSecret(),
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (res.status === 400 || res.status === 401) {
      // invalid_grant = user revoked access or token expired: needs reconnect, do not retry
      throw new GoogleAuthError(
        body.error === "invalid_grant"
          ? "Google access was revoked or expired. Please reconnect Google."
          : body.error_description || "Google authorisation failed.",
      );
    }
    if (!res.ok) throw new HttpError(`Google token refresh failed (${res.status})`, res.status);
    return body;
  }, { retries: 3 });

  accessTokenCache.set(shop, { token: json.access_token, expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
  return json.access_token;
}

export async function revokeAndDelete(shop: string) {
  const conn = await db.googleConnection.findUnique({ where: { shop } });
  accessTokenCache.delete(shop);
  if (!conn) return;
  try {
    const token = decrypt(conn.encryptedRefreshToken);
    await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
  } catch (e) {
    console.warn(`[google] revoke failed for ${shop}`, e);
  }
  await db.googleConnection.deleteMany({ where: { shop } });
}

/* ---------------------------- Sheets ---------------------------- */

async function sheetsFetch(shop: string, url: string, init: RequestInit = {}): Promise<any> {
  return withRetry(async () => {
    const token = await getAccessToken(shop);
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(init.headers || {}) },
    });
    if (res.status === 401) {
      accessTokenCache.delete(shop);
      throw new HttpError("Google rejected the access token", 503); // retry once with a fresh token
    }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      const retryAfter = Number(res.headers.get("retry-after"));
      throw new HttpError(
        body?.error?.message || `Google Sheets error ${res.status}`,
        res.status,
        Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
        body,
      );
    }
    return body;
  }, {
    retries: 5,
    onRetry: (err, attempt, delay) =>
      console.warn(`[google] retry ${attempt} in ${delay}ms: ${(err as Error).message}`),
  });
}

/** A1 sheet reference with the title quoted. */
export const a1 = (title: string, range: string) => `'${title.replace(/'/g, "''")}'!${range}`;

export async function createSpreadsheet(shop: string, title: string, sheetTitle: string) {
  const body = await sheetsFetch(shop, SHEETS, {
    method: "POST",
    body: JSON.stringify({
      properties: { title },
      sheets: [{ properties: { title: sheetTitle, gridProperties: { frozenRowCount: 1 } } }],
    }),
  });
  return {
    spreadsheetId: body.spreadsheetId as string,
    spreadsheetUrl: body.spreadsheetUrl as string,
    sheetGid: body.sheets?.[0]?.properties?.sheetId as number,
  };
}

/** Returns false when the sheet was deleted/trashed or the app lost access. */
export async function spreadsheetExists(shop: string, spreadsheetId: string): Promise<boolean> {
  try {
    await sheetsFetch(shop, `${SHEETS}/${spreadsheetId}?fields=spreadsheetId`);
    return true;
  } catch (e) {
    if (e instanceof HttpError && (e.status === 404 || e.status === 403)) return false;
    throw e;
  }
}

export async function readIdColumn(shop: string, spreadsheetId: string, sheetTitle: string): Promise<unknown[]> {
  const range = encodeURIComponent(a1(sheetTitle, "A:A"));
  const body = await sheetsFetch(
    shop,
    `${SHEETS}/${spreadsheetId}/values/${range}?valueRenderOption=UNFORMATTED_VALUE&majorDimension=COLUMNS`,
  );
  return body.values?.[0] ?? [];
}

export async function batchWriteRows(
  shop: string,
  spreadsheetId: string,
  sheetTitle: string,
  rows: { rowNumber: number; values: Cell[] }[],
) {
  // Chunk to keep request bodies well under Google's limits.
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await sheetsFetch(shop, `${SHEETS}/${spreadsheetId}/values:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        valueInputOption: "USER_ENTERED",
        data: chunk.map((r) => ({ range: a1(sheetTitle, `A${r.rowNumber}`), values: [r.values] })),
      }),
    });
  }
}

/** Make sure the grid has at least `rows` rows (appending past the grid end fails otherwise). */
export async function ensureGridRows(shop: string, spreadsheetId: string, sheetGid: number, rows: number, currentRows: number) {
  if (rows <= currentRows) return;
  await sheetsFetch(shop, `${SHEETS}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: [{ appendDimension: { sheetId: sheetGid, dimension: "ROWS", length: rows - currentRows + 500 } }],
    }),
  });
}

export async function getGridRowCount(shop: string, spreadsheetId: string, sheetGid: number): Promise<number> {
  const body = await sheetsFetch(shop, `${SHEETS}/${spreadsheetId}?fields=sheets.properties`);
  const sheet = (body.sheets ?? []).find((s: any) => s.properties?.sheetId === sheetGid);
  return sheet?.properties?.gridProperties?.rowCount ?? 1000;
}

/** Delete rows (1-based numbers), which must be sorted descending. */
export async function deleteRows(shop: string, spreadsheetId: string, sheetGid: number, rowNumbersDesc: number[]) {
  if (!rowNumbersDesc.length) return;
  await sheetsFetch(shop, `${SHEETS}/${spreadsheetId}:batchUpdate`, {
    method: "POST",
    body: JSON.stringify({
      requests: rowNumbersDesc.map((rn) => ({
        deleteDimension: { range: { sheetId: sheetGid, dimension: "ROWS", startIndex: rn - 1, endIndex: rn } },
      })),
    }),
  });
}

export async function clearSheet(shop: string, spreadsheetId: string, sheetTitle: string) {
  await sheetsFetch(shop, `${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(a1(sheetTitle, "A:ZZ"))}:clear`, {
    method: "POST",
    body: "{}",
  });
}

export async function writeCells(shop: string, spreadsheetId: string, range: string, values: Cell[][]) {
  await sheetsFetch(shop, `${SHEETS}/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
    method: "PUT",
    body: JSON.stringify({ values }),
  });
}
