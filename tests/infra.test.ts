import { describe, expect, it, vi } from "vitest";
import { decrypt, encrypt, loadKey, signState, verifyState } from "../app/lib/crypto.server";
import { backoffDelay, HttpError, withRetry } from "../app/lib/retry";

const key = loadKey("00".repeat(32));

describe("AES-GCM token encryption", () => {
  it("round-trips and uses a fresh IV each time", () => {
    const a = encrypt("1//refresh-token", key);
    const b = encrypt("1//refresh-token", key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe("1//refresh-token");
  });

  it("rejects tampered ciphertext", () => {
    const parts = encrypt("secret", key).split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decrypt(parts.join("."), key)).toThrow();
  });

  it("rejects a wrong key and malformed keys", () => {
    const c = encrypt("secret", key);
    expect(() => decrypt(c, loadKey("11".repeat(32)))).toThrow();
    expect(() => loadKey("short")).toThrow();
  });
});

describe("OAuth state", () => {
  it("verifies, expires and rejects tampering", () => {
    const s = signState({ shop: "demo.myshopify.com" }, "sec", 600, 0);
    expect(verifyState(s, "sec", 1000)).toEqual({ shop: "demo.myshopify.com" });
    expect(verifyState(s, "sec", 601_000)).toBeNull();
    expect(verifyState(s, "other", 1000)).toBeNull();
    expect(verifyState(s.replace(/^./, "x"), "sec", 1000)).toBeNull();
  });
});

describe("retry with exponential backoff", () => {
  it("doubles the delay and caps it", () => {
    expect([0, 1, 2, 3].map((a) => backoffDelay(a, 100, 500, 0))).toEqual([100, 200, 400, 500]);
  });

  it("retries 429/5xx then succeeds", async () => {
    const sleeps: number[] = [];
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new HttpError("rate", 429))
      .mockRejectedValueOnce(new HttpError("down", 503))
      .mockResolvedValue("ok");
    const res = await withRetry(fn, { baseMs: 10, jitter: 0, sleep: async (ms) => void sleeps.push(ms) });
    expect(res).toBe("ok");
    expect(sleeps).toEqual([10, 20]);
  });

  it("honours Retry-After when it is longer than the backoff", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(new HttpError("rate", 429, 5000)).mockResolvedValue(1);
    await withRetry(fn, { baseMs: 10, jitter: 0, sleep: async (ms) => void sleeps.push(ms) });
    expect(sleeps).toEqual([5000]);
  });

  it("does not retry 4xx client errors and gives up after the limit", async () => {
    const bad = vi.fn().mockRejectedValue(new HttpError("bad", 400));
    await expect(withRetry(bad, { sleep: async () => {} })).rejects.toThrow("bad");
    expect(bad).toHaveBeenCalledTimes(1);
    const down = vi.fn().mockRejectedValue(new HttpError("down", 500));
    await expect(withRetry(down, { retries: 2, sleep: async () => {} })).rejects.toThrow("down");
    expect(down).toHaveBeenCalledTimes(3);
  });
});
