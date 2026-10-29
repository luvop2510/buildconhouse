import assert from 'node:assert/strict';
import { analyticsCurrency, analyticEntityAmount, visibleAnalyticsFields, analyticsNextFilters } from '../src/components/salesAnalytics/currencyScope.ts';
const totals = { sales: 100, sales_rnb: 50, average_order_value: 25, average_order_value_rnb: 10, orders: 9 };
for (const floor of ['all', 'ground-floor', 'first-floor', 'second-floor', undefined]) {
  assert.equal(analyticsCurrency(floor), 'INR');
  assert.equal(analyticEntityAmount(totals, floor), 100);
  assert.ok(visibleAnalyticsFields(totals, floor).every(([key]) => !key.endsWith('_rnb')));
}
assert.equal(analyticsCurrency('third-floor'), 'RNB');
assert.equal(analyticEntityAmount(totals, 'third-floor'), 50);
assert.deepEqual(Object.fromEntries(visibleAnalyticsFields(totals, 'third-floor')), { sales_rnb: 50, average_order_value_rnb: 10, orders: 9 });
assert.equal(analyticEntityAmount({ sales: 100, sales_rnb: null }, 'third-floor'), null);
assert.deepEqual(Object.fromEntries(visibleAnalyticsFields({ currency: 'RNB', sales: 50 }, 'all')), { currency: 'RNB', sales: 50 });
console.log('Furniture-only aggregate currency display and source currency preservation passed');

assert.deepEqual(analyticsNextFilters({floor_id:'all',currency:'INR'},{floor_id:'third-floor'}),{floor_id:'third-floor',currency:''});
assert.deepEqual(analyticsNextFilters({floor_id:'all',currency:'INR'},{preset:'this_month'}),{preset:'this_month'});
assert.deepEqual(analyticsNextFilters({floor_id:'all'},{floor_id:'third-floor',currency:'RNB'}),{floor_id:'third-floor',currency:'RNB'});
