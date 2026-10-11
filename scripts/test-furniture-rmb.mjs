import assert from 'node:assert/strict';
import { chargeCents, depositCents, furnitureCurrencyLabel, ledgerTotals, rmbText } from '../src/utils/furnitureRmb.ts';

assert.equal(furnitureCurrencyLabel('RMB'), 'RNB');
assert.equal(furnitureCurrencyLabel('INR'), 'INR');
assert.equal(furnitureCurrencyLabel('USD'), 'USD');

assert.equal(rmbText(chargeCents({ amount_rmb: '2.675', description: 'Purchase' })), '2.68');
assert.equal(rmbText(depositCents({ amount: '2200000', rate: '15.12', currency: 'INR' })), '145502.65');
assert.equal(rmbText(depositCents({ amount: '200', rate: '7.25', currency: 'USD' })), '1450.00');
assert.equal(rmbText(depositCents({ amount: '100', rate: '1', currency: 'RMB' })), '100.00');
assert.equal(depositCents({ amount: '100', rate: '2', currency: 'RMB' }), null);
for (const invalid of ['NaN', 'Infinity', '0', '-1', '1e2', '1.1234567', '1000000000001', '0.001']) {
  assert.equal(chargeCents({ amount_rmb: invalid }), null);
}
const totals = ledgerTotals([{ amount_rmb: '172250' }, { amount_rmb: '60288' }], [{ amount: '2200000', rate: '15.12', currency: 'INR' }]);
assert.equal(rmbText(totals.payable), '232538.00');
assert.equal(rmbText(totals.received), '145502.65');
assert.equal(rmbText(totals.balance), '87035.35');
assert.equal(rmbText(ledgerTotals([{ amount_rmb: '100' }], [{ amount: '200', rate: '1', currency: 'RMB' }]).balance), '-100.00');
assert.equal(ledgerTotals([{ amount_rmb: '100' }, { amount_rmb: '' }], []).balance, null);
console.log('Furniture exact RNB preview and compatible currency-label contracts passed.');
