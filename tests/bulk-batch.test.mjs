import test from 'node:test';
import assert from 'node:assert/strict';
import { makeBulkBatchId, chunkUrls, mapBulkResults, failRows, expectedJobs, findBatch, batchCounts, isBatchFinished, batchProgressLine, batchPercent } from '../helpers/bulk-batch.js';
import { bulkItemOutcome } from '../helpers/bulk-status.js';

test('batch id uses website format and encodes the file name', () => {
  assert.equal(makeBulkBatchId('my list|v2.csv', 12, 36), 'bulk|my%20list%7Cv2.csv|12|10');
  assert.equal(makeBulkBatchId('', 3, 0), 'bulk|upload.csv|3|0');
});
test('chunkUrls splits at the cap and keeps order', () => {
  const urls = Array.from({ length: 2500 }, (_, i) => `https://a${i}.com`);
  const c = chunkUrls(urls);
  assert.deepEqual(c.map(x => x.length), [1000, 1000, 500]);
  assert.equal(c[1][0], 'https://a1000.com');
  assert.deepEqual(chunkUrls([]), []);
});
test('item mapping', () => {
  assert.equal(bulkItemOutcome({ status: 'QUEUED', jobId: 'j' }).label, 'Queued');
  assert.equal(bulkItemOutcome({ status: 'PAUSED' }).kind, 'queued');
  assert.equal(bulkItemOutcome({ status: 'COMPLETED' }).label, 'Done');
  assert.equal(bulkItemOutcome({ status: 'SKIPPED', error: 'out_of_credits' }).label, 'Not sent');
  const inv = bulkItemOutcome({ status: 'INVALID', error: 'bad url' });
  assert.equal(inv.label, 'Failed');
  assert.equal(inv.reason, 'bad url');
  assert.equal(bulkItemOutcome({ status: 'SKIPPED', error: 'internal_error' }).label, 'Failed');
  assert.equal(bulkItemOutcome(undefined).label, 'Failed');
});
test('mapBulkResults pairs by position and flags missing', () => {
  const rows = mapBulkResults(['a', 'b'], [{ status: 'QUEUED', jobId: '1' }]);
  assert.equal(rows[0].url, 'a');
  assert.equal(rows[0].kind, 'queued');
  assert.equal(rows[1].kind, 'failed');
  assert.equal(failRows(['x'], 'boom')[0].reason, 'boom');
});
test('expectedJobs counts distinct accepted job ids', () => {
  const rows = [{ kind: 'queued', jobId: '1' }, { kind: 'queued', jobId: '1' }, { kind: 'done', jobId: '2' }, { kind: 'failed' }];
  assert.equal(expectedJobs(rows), 2);
});
test('counts, progress line and finish', () => {
  const batches = [{ batchId: 'x', total: 4, completed: 1, failed: 1, running: 2, paused: 0 }];
  const c = batchCounts(findBatch(batches, 'x'), 4);
  assert.equal(batchProgressLine(c), '1 of 4 done · 2 queued · 1 failed');
  assert.equal(batchPercent(c), 50);
  assert.equal(isBatchFinished(c, 4), false);
  const fin = batchCounts({ total: 4, completed: 3, failed: 1, running: 0, paused: 0 }, 4);
  assert.equal(isBatchFinished(fin, 4), true);
  const paused = batchCounts({ total: 4, completed: 1, failed: 0, running: 0, paused: 3 }, 4);
  assert.equal(batchProgressLine(paused), 'Paused · 1 of 4 done · 3 paused · 0 failed');
  assert.equal(isBatchFinished(paused, 4), false);
});
test('batch not yet visible is not finished; nothing accepted is finished', () => {
  assert.equal(findBatch([], 'x'), null);
  assert.equal(isBatchFinished(batchCounts(null, 5), 5), false);
  assert.equal(isBatchFinished(batchCounts(null, 0), 0), true);
});
