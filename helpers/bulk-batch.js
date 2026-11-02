/**
 * helpers/bulk-batch.js
 *
 * Pure logic for the single-request website bulk flow: chunking, the batch id
 * format the website uses, mapping the endpoint's results into rows, and the
 * progress text from GET /jobs/batches counts.
 */
import { bulkItemOutcome, bulkNotSentOutcome } from './bulk-status.js';

/** Server cap per POST /analyze/bulk request. */
export const BULK_MAX_URLS = 1000;

/** `bulk|<encodeURIComponent(fileName)>|<total>|<ts36>`, the website's own format. */
export function makeBulkBatchId(fileName, total, now = Date.now()) {
  const name = String(fileName || '').trim() || 'upload.csv';
  return `bulk|${encodeURIComponent(name)}|${total}|${now.toString(36)}`;
}

/**
 * Urls per request. Well under the server cap so one request finishes in far
 * less than the MV3 service worker's lifetime; progress is saved per chunk.
 */
export const BULK_CHUNK_SIZE = 200;

/** A 'sending' phase with no chunk started for this long is treated as a dead worker. */
export const BULK_STALE_MS = 2 * 60 * 1000;

/** Split a list into chunks of at most `size` (default BULK_CHUNK_SIZE). */
export function chunkUrls(urls, size = BULK_CHUNK_SIZE) {
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
  for (const r of rows) if (r.jobId) ids.add(r.jobId);
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

/**
 * Finished: nothing running or paused in jobs/batches. A batch missing from
 * jobs/batches after a successful poll (e.g. every url was a cache hit) is
 * finished too, judged from the send-time results. Call only after a successful poll.
 */
export function isBatchFinished(counts, found = true) {
  if (!found) return true;
  return counts.running === 0 && counts.paused === 0;
}

/** True when a 'sending' batch has had no chunk activity for BULK_STALE_MS. */
export function isSendingStale(active, now = Date.now()) {
  if (!active || active.phase !== 'sending') return false;
  const last = active.chunkStartedAt || active.sentAt || active.startedAt || 0;
  return now - last > BULK_STALE_MS;
}

/**
 * A dead worker left rows in 'sending'. Mark them "Not sent" (retryable; the
 * server is idempotent per batchId+url) and move the batch on.
 * Returns { active, rows, finished }.
 */
export function reconcileStale(active, rows) {
  const next = rows.map(r => (r.kind === 'sending'
    ? { url: r.url, ...bulkNotSentOutcome(), reason: 'Sending was interrupted. Retry to send these.' }
    : r));
  const expected = expectedJobs(next);
  const finished = expected === 0;
  return { active: { ...active, expected, phase: finished ? 'finished' : 'tracking' }, rows: next, finished };
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

/** Poll rows (jobs list) at most this often; counts poll stays at BULK_POLL_MS. */
export const BULK_ROWS_POLL_MS = 15000;

/**
 * Refresh row badges from GET /jobs?batchId= (matched by jobId = job._id).
 * COMPLETED -> Done, FAILED -> Failed (+ job.error), PAUSED -> Paused,
 * QUEUED/PROCESSING -> Queued. Rows without a jobId are left alone.
 * Returns { rows, changed }; never mutates the input.
 */
export function applyJobStatuses(rows, jobs) {
  const byId = new Map();
  for (const j of Array.isArray(jobs) ? jobs : []) if (j && j._id != null) byId.set(String(j._id), j);
  let changed = false;
  const next = rows.map(r => {
    const job = r.jobId ? byId.get(r.jobId) : null;
    if (!job) return r;
    const status = String(job.status || '').toUpperCase();
    let patch;
    if (status === 'COMPLETED') patch = { kind: 'done', state: 'done', label: 'Done', reason: '' };
    else if (status === 'FAILED') patch = { kind: 'failed', state: 'error', label: 'Failed', reason: typeof job.error === 'string' && job.error ? job.error : 'The analysis failed.' };
    else if (status === 'PAUSED') patch = { kind: 'queued', state: 'queued', label: 'Paused', reason: '' };
    else if (status === 'QUEUED' || status === 'PROCESSING') patch = { kind: 'queued', state: 'queued', label: 'Queued', reason: '' };
    else return r;
    if (patch.kind === r.kind && patch.label === r.label && patch.reason === (r.reason || '')) return r;
    changed = true;
    return { ...r, ...patch };
  });
  return { rows: next, changed };
}
