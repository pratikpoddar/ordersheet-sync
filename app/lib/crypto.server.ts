import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * ENCRYPTION_KEY must be 32 bytes, given as 64 hex chars or base64.
 * Generate one with: openssl rand -hex 32
 */
export function loadKey(raw = process.env.ENCRYPTION_KEY): Buffer {
  if (!raw) throw new Error("ENCRYPTION_KEY is not set");
  const key = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must decode to exactly 32 bytes");
  return key;
}

/** AES-256-GCM. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encrypt(plaintext: string, key: Buffer = loadKey()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decrypt(payload: string, key: Buffer = loadKey()): string {
  const [v, ivB, tagB, ctB] = payload.split(".");
  if (v !== "v1" || !ivB || !tagB || ctB === undefined) throw new Error("Unrecognised ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB, "base64url"));
  decipher.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ctB, "base64url")), decipher.final()]).toString("utf8");
}

/* Signed, expiring OAuth `state` so the Google callback knows which shop started it. */

export function signState(
  data: { shop: string },
  secret = process.env.SHOPIFY_API_SECRET || "",
  ttlSeconds = 600,
  now = Date.now(),
): string {
  if (!secret) throw new Error("SHOPIFY_API_SECRET is not set");
  const body = Buffer.from(
    JSON.stringify({ s: data.shop, e: Math.floor(now / 1000) + ttlSeconds, n: randomBytes(8).toString("hex") }),
  ).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyState(
  state: string,
  secret = process.env.SHOPIFY_API_SECRET || "",
  now = Date.now(),
): { shop: string } | null {
  const [body, sig] = (state || "").split(".");
  if (!body || !sig || !secret) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (typeof parsed.s !== "string" || typeof parsed.e !== "number") return null;
    if (parsed.e * 1000 < now) return null;
    if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(parsed.s)) return null;
    return { shop: parsed.s };
  } catch {
    return null;
  }
}
