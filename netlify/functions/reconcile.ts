import type { Config } from "@netlify/functions";
import { runScheduledSweep } from "../../app/services/scheduler.server";

/**
 * Netlify scheduled function: the reconciliation sweep, every 15 minutes.
 * Scheduled functions get 30s and no request payload, and only run on published deploys.
 * The sweep stops itself at SCHEDULED_BUDGET_MS (default 25s); unfinished jobs keep their
 * cursor in Postgres and continue on the next run.
 */
export default async () => {
  try {
    const summary = await runScheduledSweep();
    console.log("[reconcile]", JSON.stringify(summary));
  } catch (e) {
    console.error("[reconcile] sweep failed", e);
  }
  return new Response(null, { status: 204 });
};

export const config: Config = {
  schedule: "*/15 * * * *",
};
