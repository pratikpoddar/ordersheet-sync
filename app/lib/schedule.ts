import { entitlementsFor, type PlanTier } from "./plans";

export const ERROR_COOLDOWN_MS = 60 * 60_000;

/**
 * Whether a shop's safety-net reconciliation is due.
 * Free: once a day. Pro: hourly (webhooks do the real-time work).
 * After a failure we wait an hour before retrying, so a revoked Google
 * token doesn't hammer the APIs every 15 minutes.
 */
export function isReconcileDue(
  args: { plan: PlanTier; lastReconciledAt: Date | null; lastErrorAt: Date | null },
  now = new Date(),
): boolean {
  const every = entitlementsFor(args.plan).reconcileEveryMinutes * 60_000;
  const last = args.lastReconciledAt?.getTime() ?? 0;
  if (
    args.lastErrorAt &&
    args.lastErrorAt.getTime() > last &&
    now.getTime() - args.lastErrorAt.getTime() < ERROR_COOLDOWN_MS
  ) {
    return false;
  }
  return now.getTime() - last >= every;
}
