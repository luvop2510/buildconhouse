import assert from 'node:assert/strict';
import { analyticsBoundary, analyticsDateDisplay, validAnalyticsRange } from '../src/components/salesAnalytics/dateBounds.ts';

const chartStart = '2026-10-09T18:30:00+00:00';
const chartEnd = '2026-10-10T18:30:00+00:00';
assert.equal(analyticsDateDisplay(chartStart), '2026-10-10');
assert.equal(analyticsDateDisplay(chartEnd, true), '2026-10-10');
assert.equal(analyticsDateDisplay('2026-10-10', true), '2026-10-10');
assert.equal(analyticsBoundary('2026-10-10'), Date.parse(chartStart));
assert.equal(analyticsBoundary('2026-10-10', true), Date.parse(chartEnd));
assert.ok(validAnalyticsRange(chartStart, chartEnd));
assert.ok(validAnalyticsRange('2026-10-10', '2026-10-10'));
assert.equal(validAnalyticsRange('2026-02-30', '2026-03-01'), false);
assert.equal(validAnalyticsRange('2026-10-11', '2026-10-10'), false);
assert.equal(validAnalyticsRange('2026-10-10T18:30:00+00:00', chartEnd), false);
assert.equal(analyticsBoundary('2026-02-30T00:00:00Z'), null);
console.log('Analytics date bounds: exact timestamp ranges, inclusive India dates, midnight display and invalid calendar values passed.');
