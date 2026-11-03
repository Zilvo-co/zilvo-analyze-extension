import test from 'node:test';
import assert from 'node:assert/strict';
import { listCountsText, skippedLeadsNote } from '../helpers/list-counts.js';

test('account list shows companies only', () => {
  assert.equal(listCountsText({ type: 'accounts', leads: 0, companies: 12 }), '12 companies');
});

test('lead list shows leads and analyzable companies', () => {
  assert.equal(listCountsText({ type: 'leads', leads: 50, companies: 31 }), '50 leads · 31 companies');
});

test('skipped note: singular, plural, none, and never for accounts', () => {
  assert.equal(skippedLeadsNote({ type: 'leads', skippedLeads: 1 }), '1 lead has no company page');
  assert.equal(skippedLeadsNote({ type: 'leads', skippedLeads: 4 }), '4 leads have no company page');
  assert.equal(skippedLeadsNote({ type: 'leads' }), '');
  assert.equal(skippedLeadsNote({ type: 'accounts', skippedLeads: 3 }), '');
});
