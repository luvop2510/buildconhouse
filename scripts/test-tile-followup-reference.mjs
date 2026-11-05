import assert from 'node:assert/strict';
import test from 'node:test';
import { followupLegacyReference } from '../src/components/tiles/followupReference.ts';

test('unlinked follow-up referrers keep their names and known profession', () => {
  assert.equal(followupLegacyReference({ referrer_name: '  A Shah  ', referrer_type: 'architect' }), 'ARC-A Shah');
  assert.equal(followupLegacyReference({ referrer_name: 'B Patel', referrer_type: 'interior_designer' }), 'INT-B Patel');
  assert.equal(followupLegacyReference({ referrer_name: 'C Rao' }), 'C Rao');
});

test('linked or missing follow-up referrers do not become legacy references', () => {
  assert.equal(followupLegacyReference({ referrer_id: 'existing', referrer_name: 'A Shah', referrer_type: 'architect' }), '');
  assert.equal(followupLegacyReference({ referrer_id: 'orphan', referrer_name: 'D Roy' }), 'D Roy');
  assert.equal(followupLegacyReference({ reference_source: 'Walk-in' }), '');
});
