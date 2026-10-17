import assert from 'node:assert/strict';
import { walkinSummaryFilters } from '../src/utils/walkinSummary.ts';

const sunday = new Date('2026-10-18T23:59:59.000Z');
assert.deepEqual(walkinSummaryFilters('week', sunday), { date_from: '2026-10-12T00:00:00' });
assert.deepEqual(walkinSummaryFilters('week', new Date('2026-10-19T00:00:00Z')), { date_from: '2026-10-19T00:00:00' });
assert.deepEqual(walkinSummaryFilters('week', new Date('2027-01-01T00:00:00Z')), { date_from: '2026-12-28T00:00:00' });
assert.deepEqual(walkinSummaryFilters('today', sunday), { date_from: '2026-10-18T00:00:00', date_to: '2026-10-18T23:59:59.999999Z' });
const cases = [
  ['pending', ['new', 'contacted', 'selection_scheduled']],
  ['scheduled', ['selection_scheduled']],
  ['converted', ['selection_completed', 'quotation_created', 'converted']],
  ['average', ['selection_completed', 'quotation_created', 'converted']],
  ['lost', ['lost']],
  ['conversion', ['selection_completed', 'quotation_created', 'converted', 'lost']],
];
for (const [view, statuses] of cases) assert.deepEqual(walkinSummaryFilters(view).status.split(','), statuses);
assert.deepEqual(walkinSummaryFilters(null), {});
console.log('Walk-in summary filters: UTC day/week/year boundaries and exact dashboard status groups passed.');
