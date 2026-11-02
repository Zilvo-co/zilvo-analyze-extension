/**
 * helpers/bulk-status.js
 *
 * Pure status -> label mapping for Bulk Analyze. The server analyses
 * asynchronously: POST /analyze usually returns QUEUED, and only a cache hit
 * comes back COMPLETED. A successful request therefore means "sent", not "done".
 */

/** Map an API job status (or a failed request) to a row state + badge label. */
export function bulkRowOutcome(result) {
  if (!result || !result.success) return { kind: 'failed', state: 'error', label: 'Failed' };
  const status = String(result.jobStatus || '').toUpperCase();
  if (status === 'COMPLETED') return { kind: 'done', state: 'done', label: 'Done' };
  if (status === 'FAILED') return { kind: 'failed', state: 'error', label: 'Failed' };
  // QUEUED, PROCESSING, PAUSED, or a missing/unknown status: accepted, not finished.
  return { kind: 'queued', state: 'queued', label: 'Queued' };
}

/** Progress line while sending, e.g. "3 / 10 sent · 1 done". */
export function bulkProgressText(sent, total, done) {
  return `${sent} / ${total} sent · ${done} done`;
}

/** True when a failed request means the account is out of credits (HTTP 402). */
export function isOutOfCredits(result) {
  return !!result && result.success === false && result.status === 402;
}

/** Row state for a row the run never sent because credits ran out. */
export function bulkNotSentOutcome() {
  return { kind: 'notSent', state: 'pending', label: 'Not sent' };
}

/**
 * Final summary, e.g. "Stopped: out of credits. 120 queued, analysis continues
 * in the cloud. 3 already done. 2 failed. 40 not sent."
 */
export function bulkSummaryText({ queued = 0, done = 0, failed = 0, notSent = 0, outOfCredits = false }) {
  const parts = [];
  if (outOfCredits) parts.push('Stopped: out of credits.');
  if (queued > 0) parts.push(`${queued} queued, analysis continues in the cloud.`);
  if (done > 0) parts.push(`${done} already done.`);
  if (failed > 0) parts.push(`${failed} failed.`);
  if (notSent > 0) parts.push(`${notSent} not sent.`);
  return parts.join(' ');
}

/**
 * Row outcome for one item of the bulk endpoint's `results` array
 * ({ url, jobId?, status, error? }). SKIPPED out_of_credits is "Not sent"
 * (retryable after a top-up); INVALID and other SKIPPED reasons are "Failed".
 */
export function bulkItemOutcome(item) {
  if (!item || typeof item !== 'object') {
    return { kind: 'failed', state: 'error', label: 'Failed', reason: 'The server returned no result for this URL.' };
  }
  const status = String(item.status || '').toUpperCase();
  const error = typeof item.error === 'string' && item.error ? item.error : '';
  if (status === 'SKIPPED' && error === 'out_of_credits') return { ...bulkNotSentOutcome(), reason: 'Out of credits. Top up to analyze the rest.' };
  if (status === 'INVALID') return { kind: 'failed', state: 'error', label: 'Failed', reason: error || 'Invalid URL.' };
  if (status === 'SKIPPED') return { kind: 'failed', state: 'error', label: 'Failed', reason: error || 'The server skipped this URL.' };
  const base = bulkRowOutcome({ success: true, jobStatus: status });
  return { ...base, reason: '', jobId: typeof item.jobId === 'string' ? item.jobId : undefined };
}
