import assert from 'node:assert/strict';
import { handleTableScrollKey, tableColumnLayout, tableMinWidth } from '../src/components/tableLayout.ts';

// The reported Kitchen overlap: summed fixed columns omitted seven gaps + gutters.
const kitchen = [220, 240, ...Array(8).fill(180)].map(width => ({ label: 'Column', width }));
assert.equal(tableMinWidth(kitchen, 12, 16), 2040);
assert.equal(tableMinWidth([{ label: 'Order', flex: 2 }, { label: 'Date', width: 62 }, { label: 'Value' }, { label: 'Due' }], 12, 16), 610);
assert.equal(tableMinWidth([{ label: 'Name', flex: 2 }, { label: 'Revenue' }, { label: 'Orders' }], 12, 16), 536);
assert.equal(tableMinWidth([], 12, 16), 32);
assert.deepEqual(tableColumnLayout({ width: 220 }), { width: 220, flexGrow: 0, flexShrink: 0, minWidth: 0 });
assert.deepEqual(tableColumnLayout({ width: 0 }), { width: 0, flexGrow: 0, flexShrink: 0, minWidth: 0 });
assert.deepEqual(tableColumnLayout({ flex: 2 }), { flexBasis: 0, flexGrow: 2, flexShrink: 1, minWidth: 0 });
assert.deepEqual(tableColumnLayout({}), { flexBasis: 0, flexGrow: 1, flexShrink: 1, minWidth: 0 });
console.log('Shared table layout: fixed/mixed/flexible column geometry, gutters and zero-width cases passed.');

const region = { scrollLeft: 0, scrollWidth: 2040, clientWidth: 800 };
let prevented = 0;
const key = (value, overrides = {}) => handleTableScrollKey({ key: value, target: region, currentTarget: region, preventDefault: () => prevented++, ...overrides });
key('End'); assert.equal(region.scrollLeft, 1240);
key('Home'); assert.equal(region.scrollLeft, 0);
key('ArrowRight'); assert.equal(region.scrollLeft, 640);
key('ArrowRight'); assert.equal(region.scrollLeft, 1240);
key('ArrowLeft'); assert.equal(region.scrollLeft, 600);
key('ArrowLeft'); assert.equal(region.scrollLeft, 0);
for (const overrides of [{ target: {} }, { altKey: true }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }]) key('End', overrides);
key('Enter'); key('ArrowDown');
assert.equal(region.scrollLeft, 0, 'Child controls, modified shortcuts and unrelated keys retain their behaviour');
assert.equal(prevented, 6, 'Only owned horizontal scroll keys prevent the browser default');
console.log('Shared table keyboard: Home/End/Arrows, bounds, child controls and modified shortcuts passed.');
