import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunGate, unsentIndexes } from '../helpers/run-gate.js';

test('running gate never blocks', async () => {
  const g = createRunGate();
  await g.waitIfPaused();
  assert.equal(g.isPaused(), false);
});

test('paused gate holds the loop until resume, and sends each row exactly once', async () => {
  const g = createRunGate();
  const sent = [];
  const rows = [0, 1, 2, 3, 4];
  const loop = (async () => {
    for (const r of rows) {
      await g.waitIfPaused();
      sent.push(r);
      if (r === 1) g.pause(); // user pauses while row 1 is in flight
      await Promise.resolve();
    }
  })();
  await new Promise(r => setTimeout(r, 10));
  assert.deepEqual(sent, [0, 1]);          // nothing after the pause
  assert.equal(g.isPaused(), true);
  g.resume();
  await loop;
  assert.deepEqual(sent, [0, 1, 2, 3, 4]); // continues, no repeats
});

test('resume releases every waiter and pause is idempotent', async () => {
  const g = createRunGate();
  g.pause(); g.pause();
  const a = g.waitIfPaused(); const b = g.waitIfPaused();
  g.resume();
  await Promise.all([a, b]);
  assert.equal(g.isPaused(), false);
});

test('unsentIndexes lists the rows still to send', () => {
  assert.deepEqual(unsentIndexes([true, true, false, false]), [2, 3]);
  assert.deepEqual(unsentIndexes([true, true]), []);
  assert.deepEqual(unsentIndexes([]), []);
});
