/**
 * Copy for an extracted list's counts on the Lists screen.
 *
 * An account extraction has no people (every row is a company); a lead
 * extraction shows leads and the companies that will really be analyzed.
 */
const n = (v) => (Number(v) || 0).toLocaleString();

export function listCountsText(list) {
  if (list.type === 'accounts') return `${n(list.companies)} companies`;
  return `${n(list.leads)} leads · ${n(list.companies)} companies`;
}

/** Short note when some leads have no company page; '' when none. */
export function skippedLeadsNote(list) {
  const k = Number(list.skippedLeads) || 0;
  if (list.type === 'accounts' || k <= 0) return '';
  return `${n(k)} ${k === 1 ? 'lead has' : 'leads have'} no company page`;
}
