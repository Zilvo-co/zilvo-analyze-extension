// ── Credit gating ────────────────────────────────────────────────────────────
// The server charges `ci.analyze` inside /api/company-intelligence/analyze and
// rejects an underfunded caller with a 402. That check is the authority — the
// helpers here only stop the user from starting work that is already known to
// fail, which on the LinkedIn path means a background tab, a 3.5s render wait
// and a scrape before the rejection ever arrives.

/** The single billable action the extension performs. */
export const CI_ANALYZE_ACTION = 'ci.analyze';

/** Used when /api/pricing is unreachable, so the UI never renders a blank cost. */
export const CI_ANALYZE_FALLBACK_COST = 5;

/**
 * Whether `credits` covers `cost`.
 *
 * A null balance means the lookup failed or has not returned yet. That stays
 * permissive on purpose: a hiccup on /api/credits must not lock a paying user
 * out of the extension, and the server's 402 still catches the real case.
 */
export function canAfford(credits: number | null, cost: number): boolean {
  return credits === null || credits >= cost;
}

/** How many analyses `credits` buys. Infinity when the balance is unknown. */
export function affordableCount(credits: number | null, cost: number): number {
  if (credits === null) return Infinity;
  if (cost <= 0) return Infinity;
  return Math.floor(credits / cost);
}
