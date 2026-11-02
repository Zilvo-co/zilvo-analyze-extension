import test from 'node:test';
import assert from 'node:assert/strict';
import { isOutOfCredits, bulkNotSentOutcome, bulkRowOutcome, bulkProgressText, bulkSummaryText } from '../helpers/bulk-status.js';

test('QUEUED, PROCESSING, PAUSED and unknown map to Queued', () => {
  for (const status of ['QUEUED', 'PROCESSING', 'PAUSED', 'queued', undefined, 'WEIRD']) {
    assert.equal(bulkRowOutcome({ success: true, jobStatus: status }).label, 'Queued');
    assert.equal(bulkRowOutcome({ success: true, jobStatus: status }).kind, 'queued');
  }
});
test('COMPLETED maps to Done', () => {
  assert.deepEqual(bulkRowOutcome({ success: true, jobStatus: 'COMPLETED' }), { kind: 'done', state: 'done', label: 'Done' });
});
test('FAILED status and request errors map to Failed', () => {
  assert.equal(bulkRowOutcome({ success: true, jobStatus: 'FAILED' }).label, 'Failed');
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

test('402 detection uses the HTTP status, not the job status', () => {
  assert.equal(isOutOfCredits({ success: false, status: 402 }), true);
  assert.equal(isOutOfCredits({ success: false, status: 500 }), false);
  assert.equal(isOutOfCredits({ success: true, jobStatus: 'QUEUED' }), false);
  assert.equal(isOutOfCredits(undefined), false);
});
test('not sent rows are not Failed', () => {
  assert.equal(bulkNotSentOutcome().label, 'Not sent');
  assert.notEqual(bulkNotSentOutcome().kind, 'failed');
});
test('out of credits summary', () => {
  assert.equal(bulkSummaryText({ queued: 118, failed: 1, notSent: 40, outOfCredits: true }),
    'Stopped: out of credits. 118 queued, analysis continues in the cloud. 1 failed. 40 not sent.');
});
