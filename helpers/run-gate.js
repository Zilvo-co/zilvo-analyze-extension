/**
 * helpers/run-gate.js
 *
 * Pause/resume gate for the popup's per-row loops (extracted lists, LinkedIn
 * CSV). The loop calls `await gate.waitIfPaused()` BEFORE sending each row, so
 * once paused no further row is sent, and a resumed loop carries on from the
 * same index: a row already sent is never visited again, so it is never
 * re-sent or re-charged.
 */
export function createRunGate() {
  let paused = false;
  let waiters = [];
  return {
    isPaused: () => paused,
    pause() { paused = true; },
    resume() {
      paused = false;
      const w = waiters;
      waiters = [];
      for (const release of w) release();
    },
    /** Resolves immediately when running; holds the loop while paused. */
    waitIfPaused() {
      return paused ? new Promise(res => waiters.push(res)) : Promise.resolve();
    },
  };
}

/** Rows (by index) not yet sent: what "Paused" rows are, and what resume still has to send. */
export function unsentIndexes(sentFlags) {
  const out = [];
  sentFlags.forEach((sent, i) => { if (!sent) out.push(i); });
  return out;
}
