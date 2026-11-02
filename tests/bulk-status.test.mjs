import test from 'node:test';
import assert from 'node:assert/strict';
import { bulkRowOutcome, bulkProgressText, bulkSummaryText } from '../helpers/bulk-status.js';

test('QUEUED, PROCESSING, PAUSED and unknown map to Queued', () => {
  for (const status of ['QUEUED', 'PROCESSING', 'PAUSED', 'queued', undefined, 'WEIRD']) {
    assert.equal(bulkRowOutcome({ success: true, status }).label, 'Queued');
    assert.equal(bulkRowOutcome({ success: true, status }).kind, 'queued');
  }
});
test('COMPLETED maps to Done', () => {
  assert.deepEqual(bulkRowOutcome({ success: true, status: 'COMPLETED' }), { kind: 'done', state: 'done', label: 'Done' });
});
test('FAILED status and request errors map to Failed', () => {
  assert.equal(bulkRowOutcome({ success: true, status: 'FAILED' }).label, 'Failed');
  assert.equal(bulkRowOutcome({ success: false, error: 'x' }).label, 'Failed');
  assert.equal(bulkRowOutcome(undefined).label, 'Failed');
});
test('progress text', () => {
  assert.equal(bulkProgressText(3, 10, 1), '3 / 10 sent · 1 done');
});
test('summary text', () => {
  assert.equal(bulkSummaryText({ queued: 5 }), '5 queued, analysis continues in the cloud.');
  assert.equal(bulkSummaryText({ queued: 5, done: 2, failed: 1 }),
    '5 queued, analysis continues in the cloud. 2 already done. 1 failed.');
  assert.equal(bulkSummaryText({ done: 2 }), '2 already done.');
  assert.ok(!bulkSummaryText({ queued: 1, done: 1, failed: 1 }).includes('—'));
});
