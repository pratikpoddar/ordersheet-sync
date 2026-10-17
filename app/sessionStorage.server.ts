import type { PrismaClient } from "@prisma/client";
import {
  MissingSessionStorageError,
  MissingSessionTableError,
  PrismaSessionStorage,
} from "@shopify/shopify-app-session-storage-prisma";

type Inner = PrismaSessionStorage<PrismaClient>;
type Session = Parameters<Inner["storeSession"]>[0];

/**
 * Shopify's Prisma session storage, hardened for serverless.
 *
 * PrismaSessionStorage checks that the Session table exists once, at construction, and caches
 * a failure forever. On a long-lived server that's fine, but a warm serverless instance that
 * hit one cold-start connection blip (e.g. the Supabase pooler waking up) would then fail
 * every request until Netlify recycled it. This wrapper rebuilds the inner storage once when
 * it reports "not ready" and retries the call.
 */
export class ServerlessPrismaSessionStorage {
  private inner: Inner;

  constructor(private readonly prisma: PrismaClient) {
    this.inner = this.create();
  }

  private create(): Inner {
    const storage = new PrismaSessionStorage(this.prisma, { connectionRetries: 3, connectionRetryIntervalMs: 500 });
    // The startup table check is a promise nobody awaits until the first call; observe it so a
    // cold-start failure is not an unhandled rejection (which would crash the function).
    (storage as unknown as { ready?: Promise<unknown> }).ready?.catch(() => {});
    return storage;
  }

  private async call<T>(fn: (s: Inner) => Promise<T>): Promise<T> {
    try {
      return await fn(this.inner);
    } catch (err) {
      if (err instanceof MissingSessionStorageError || err instanceof MissingSessionTableError) {
        this.inner = this.create();
        return fn(this.inner);
      }
      throw err;
    }
  }

  storeSession(session: Session) {
    return this.call((s) => s.storeSession(session));
  }
  loadSession(id: string) {
    return this.call((s) => s.loadSession(id));
  }
  deleteSession(id: string) {
    return this.call((s) => s.deleteSession(id));
  }
  deleteSessions(ids: string[]) {
    return this.call((s) => s.deleteSessions(ids));
  }
  findSessionsByShop(shop: string) {
    return this.call((s) => s.findSessionsByShop(shop));
  }
}
