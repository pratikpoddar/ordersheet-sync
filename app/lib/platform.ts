/**
 * Netlify passes its request context (incl. waitUntil) as the loader/action `context`
 * (@netlify/vite-plugin-react-router). Locally (react-router dev / shopify app dev) it is absent.
 */
export function waitUntilFrom(context: unknown): ((p: Promise<unknown>) => void) | undefined {
  const fn = (context as { waitUntil?: unknown } | null | undefined)?.waitUntil;
  return typeof fn === "function" ? (p) => (fn as (p: Promise<unknown>) => void).call(context, p) : undefined;
}
