export class HttpError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs?: number,
    public body?: unknown,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export class ThrottledError extends Error {
  constructor(public retryAfterMs = 1000) {
    super("Shopify API throttled");
    this.name = "ThrottledError";
  }
}

export interface RetryOptions {
  retries?: number; // extra attempts after the first
  baseMs?: number;
  maxMs?: number;
  /** 0..1 jitter factor; tests pass 0 for determinism */
  jitter?: number;
  isRetryable?: (err: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function backoffDelay(attempt: number, baseMs = 500, maxMs = 30_000, jitter = 0.2): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  const j = exp * jitter * Math.random();
  return Math.round(exp - j);
}

export function defaultIsRetryable(err: unknown): boolean {
  if (err instanceof ThrottledError) return true;
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  // Network-level failures (fetch TypeError, ECONNRESET, etc.)
  if (err instanceof TypeError) return true;
  const code = (err as any)?.code;
  return typeof code === "string" && /ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR/.test(code);
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 5;
  const isRetryable = opts.isRetryable ?? defaultIsRetryable;
  const doSleep = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (attempt >= retries || !isRetryable(err)) throw err;
      const hinted =
        (err as HttpError | ThrottledError)?.retryAfterMs ?? 0;
      const delay = Math.max(
        hinted,
        backoffDelay(attempt, opts.baseMs ?? 500, opts.maxMs ?? 30_000, opts.jitter ?? 0.2),
      );
      opts.onRetry?.(err, attempt + 1, delay);
      await doSleep(delay);
    }
  }
}
