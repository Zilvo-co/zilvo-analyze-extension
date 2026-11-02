/**
 * helpers/bulk-batch.js
 *
 * Pure logic for the single-request website bulk flow: chunking, the batch id
 * format the website uses, mapping the endpoint's results into rows, and the
 * progress text from GET /jobs/batches counts.
 */
import { bulkItemOutcome } from './bulk-status.js';

/** Server cap per POST /analyze/bulk request. */
export const BULK_MAX_URLS = 1000;

/** `bulk|<encodeURIComponent(fileName)>|<total>|<ts36>`, the website's own format. */
export function makeBulkBatchId(fileName, total, now = Date.now()) {
  const name = String(fileName || '').trim() || 'upload.csv';
  return `bulk|${encodeURIComponent(name)}|${total}|${now.toString(36)}`;
}

/** Split a list into chunks of at most `size` (default: the server cap). */
export function chunkUrls(urls, size = BULK_MAX_URLS) {
  const out = [];
  for (let i = 0; i < urls.length; i += size) out.push(urls.slice(i, i + size));
  return out;
}

/** Map a response's `results` onto `urls` by position; a missing entry is a failure. */
export function mapBulkResults(urls, results) {
  const list = Array.isArray(results) ? results : [];
  return urls.map((url, i) => ({ url, ...bulkItemOutcome(list[i]) }));
}

/** A whole request failed (network, 5xx): every URL in it is retryable. */
export function failRows(urls, reason) {
  return urls.map(url => ({ url, kind: 'failed', state: 'error', label: 'Failed', reason }));
}

/** Distinct accepted jobs in the rows; the server mirrors in-file duplicates onto one job. */
export function expectedJobs(rows) {
  const ids = new Set();
  for (const r of rows) if (r.jobId && (r.kind === 'queued' || r.kind === 'done')) ids.add(r.jobId);
  return ids.size;
}

/** The batch's entry in the GET /jobs/batches array, or null. */
export function findBatch(batches, batchId) {
  if (!Array.isArray(batches)) return null;
  return batches.find(b => b && b.batchId === batchId) || null;
}

const n = v => (Number.isFinite(v) ? v : 0);

/** Normalised view of a batch entry. `total` is never below what was accepted. */
export function batchCounts(batch, expected = 0) {
  const b = batch || {};
  const completed = n(b.completed);
  const failed = n(b.failed);
  const running = n(b.running);
  const paused = n(b.paused);
  return { total: Math.max(n(b.total), expected), completed, failed, running, paused, done: completed + failed };
}

/** Finished: nothing running or paused and every accepted job has a row. */
export function isBatchFinished(counts, expected) {
  if (expected <= 0) return true;
  return counts.running === 0 && counts.paused === 0 && counts.total >= expected && counts.done >= expected;
}

/** "3 of 10 done · 5 queued · 1 failed"; "Paused · ..." while parked. */
export function batchProgressLine(counts) {
  const parts = [`${counts.completed} of ${counts.total} done`];
  if (counts.running > 0) parts.push(`${counts.running} queued`);
  if (counts.paused > 0) parts.push(`${counts.paused} paused`);
  parts.push(`${counts.failed} failed`);
  const line = parts.join(' · ');
  return counts.paused > 0 ? `Paused · ${line}` : line;
}

/** Percent 0..100 of accepted work that has finished (done or failed). */
export function batchPercent(counts) {
  if (counts.total <= 0) return 0;
  return Math.min(100, Math.round((counts.done / counts.total) * 100));
}

export const BULK_POLL_MS = 5000;
