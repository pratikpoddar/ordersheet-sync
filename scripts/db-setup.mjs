// Local helper: picks the Prisma schema that matches DATABASE_URL, generates the client and
// applies migrations.
//   postgres(ql)://...  -> prisma/schema.prisma          (Postgres: Supabase in production, or a local Postgres)
//   file:...            -> prisma/sqlite/schema.prisma   (optional SQLite for quick local dev)
// Production deploys don't use this: Netlify runs `prisma generate` in the build and you run
// `npm run db:deploy` (prisma migrate deploy, via DIRECT_URL) yourself.
import { execSync } from "node:child_process";

const url = process.env.DATABASE_URL || "";
const isPg = /^postgres(ql)?:\/\//.test(url);
const schema = isPg ? "prisma/schema.prisma" : "prisma/sqlite/schema.prisma";
const env = { ...process.env };
// The Postgres schema declares directUrl = env("DIRECT_URL"); locally the same URL is fine.
if (isPg && !env.DIRECT_URL) env.DIRECT_URL = url;
console.log(`[db-setup] using ${schema}`);
const run = (cmd) => execSync(cmd, { stdio: "inherit", env });
run(`npx prisma generate --schema ${schema}`);
run(`npx prisma migrate deploy --schema ${schema}`);
