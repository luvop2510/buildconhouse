import assert from 'node:assert/strict';
import { moveQuotationLine, moveQuotationRows, reorderQuotationRoom } from '../src/components/quotation/helpers/reorder.ts';
import { cloneRoomProducts, previewQuantityIncrease, quotationRoomLines, validQuantityIncrease } from '../src/components/quotation/helpers/roomProducts.ts';

const line = (id, room, extra = {}) => ({ id, product_id: id, sku: id, name: id, room, qty: 1, unit_price: 100, discount_pct: null, ...extra });
const a = line('a', 'Bath', { category_id: 'basins', qty: 3, finish: 'Chrome' });
const part = line('part', 'Bath', { included_for_line_id: 'a', included_qty_per_parent: 2, qty: 6, unit_price: 0 });
const b = line('b', 'Bath', { category_id: 'showers', qty: 2 });
const c = line('c', 'Kitchen');
const hidden = line('hidden', 'Closed');
const legacy = line('legacy', undefined);
const state = { lines: [a, c, part, b, hidden, legacy], rooms: ['Bath', 'Kitchen', 'Closed'], activeRoom: 'Bath' };
const header = { kind: 'room-header', id: 'hdr-Bath', roomName: 'Bath' };
const row = line => ({ kind: 'line', id: line.id, line });
const rows = [header, row(a), row(part), row(b), row(legacy)];

const upwards = moveQuotationRows(rows, 'b', 1);
assert.deepEqual(upwards.map(row => row.id), ['hdr-Bath', 'b', 'a', 'part', 'legacy']);
const reordered = reorderQuotationRoom(state, 'Bath', upwards.slice(1).map(row => row.id));
assert.deepEqual(reordered.lines.map(line => line.id), ['b', 'c', 'a', 'part', 'hidden', 'legacy']);
assert.equal(reordered.lines[1], c);
assert.equal(reordered.lines[4], hidden);
assert.equal(reordered.lines[2], a);
assert.equal(reordered.lines[3], part);
assert.equal(reordered.rooms, state.rooms);
assert.equal(reorderQuotationRoom(state, 'Bath', ['a', 'b', 'legacy']), state, 'ignore stale rows');
assert.equal(moveQuotationRows(rows, 'part', 4), rows);
assert.equal(moveQuotationRows(rows, 'missing', 4), rows);
assert.equal(moveQuotationRows(rows, 'a', 0), rows);

assert.deepEqual(moveQuotationLine(state.lines, 'a', 1).map(line => line.id), ['c', 'b', 'a', 'part', 'hidden', 'legacy']);
assert.equal(moveQuotationLine(state.lines, 'part', -1), state.lines);
assert.equal(moveQuotationLine(state.lines, 'a', -1), state.lines);

const roomLines = quotationRoomLines(state, 'Bath');
assert.deepEqual(roomLines, [a, part, b, legacy]);
const preview = previewQuantityIncrease(roomLines, 2);
assert.ok(validQuantityIncrease(preview));
assert.deepEqual(preview.map(({ line, quantity }) => [line.id, quantity]), [['a', 5], ['part', 10], ['b', 4], ['legacy', 3]]);
assert.deepEqual(state.lines.map(line => line.qty), [3, 1, 6, 2, 1, 1]);
assert.equal(previewQuantityIncrease(roomLines, -1), null);
assert.equal(previewQuantityIncrease([{ ...a, godown_allocation_id: 'reserved' }], 1), null);
assert.equal(validQuantityIncrease(previewQuantityIncrease([a], Number.EPSILON)), false);

let id = 0;
const copies = cloneRoomProducts([a, part, b], 'Closed', () => `copy-${++id}`);
assert.deepEqual(copies.map(line => line.id), ['copy-1', 'copy-2', 'copy-3']);
assert.equal(copies[1].included_for_line_id, 'copy-1');
assert.equal(copies[0].qty, 3);
assert.equal(copies[0].finish, 'Chrome');
assert.equal(copies[0].unit_price, 100);
assert.ok(copies.every(line => line.room === 'Closed'));
assert.deepEqual(cloneRoomProducts([{ ...a, godown_stock_id: 'lot' }], 'Closed', () => 'unused'), []);
console.log('Quotation room products: local reorder, included groups, additive quantities, stock guards, and copy snapshots passed');
