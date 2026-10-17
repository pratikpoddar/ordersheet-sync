import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

/**
 * One PrismaClient per process, reused across warm serverless invocations (and across
 * Vite HMR reloads in dev). In production DATABASE_URL points at Supabase's transaction
 * pooler (port 6543, ?pgbouncer=true&connection_limit=1), so each function instance opens
 * at most one connection and prepared statements are disabled for PgBouncer.
 */
const prisma = globalThis.prismaGlobal ?? new PrismaClient();
globalThis.prismaGlobal = prisma;

export default prisma;
