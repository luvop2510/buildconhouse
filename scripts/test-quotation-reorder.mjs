import assert from 'node:assert/strict';
import { applyQuotationRowOrder, moveQuotationLine, moveQuotationRows } from '../src/components/quotation/helpers/reorder.ts';

const line = (id, room, extra = {}) => ({ id, product_id: id, sku: id, name: id, room, qty: 1, unit_price: 100, discount_pct: null, ...extra });
const a = line('a', 'Bath', { category_id: 'basins' });
const part = line('part', 'Bath', { included_for_line_id: 'a', unit_price: 0 });
const b = line('b', 'Bath', { category_id: 'showers' });
const c = line('c', 'Kitchen');
const hidden = line('hidden', 'Closed');
const state = { lines: [a, part, b, c, hidden], rooms: ['Bath', 'Kitchen', 'Closed'], collapsedRooms: { Closed: true } };
const header = name => ({ kind: 'room-header', id: `hdr-${name}`, roomName: name });
const row = line => ({ kind: 'line', id: line.id, line });
const rows = [header('Bath'), row(a), row(part), row(b), header('Kitchen'), row(c), header('Closed')];

// Cross-category movement is unrestricted, and included parts stay attached.
const upwards = moveQuotationRows(rows, 'b', 1);
assert.deepEqual(upwards.map(row => row.id), ['hdr-Bath', 'b', 'a', 'part', 'hdr-Kitchen', 'c', 'hdr-Closed']);
assert.deepEqual(applyQuotationRowOrder(state, upwards).lines.map(line => line.id), ['b', 'a', 'part', 'c', 'hidden']);

// Moving across rooms updates the persisted parent and its included parts.
const moved = applyQuotationRowOrder(state, moveQuotationRows(rows, 'a', 4));
assert.deepEqual(moved.lines.map(line => line.id), ['b', 'c', 'a', 'part', 'hidden']);
assert.equal(moved.lines.find(line => line.id === 'a').room, 'Kitchen');
assert.equal(moved.lines.find(line => line.id === 'part').room, 'Kitchen');
assert.equal(moved.lines.find(line => line.id === 'hidden'), hidden);
assert.equal(moved.lines.reduce((sum, line) => sum + line.unit_price * line.qty, 0), 400);

// A drop into a collapsed section still preserves every unseen product.
const intoClosed = applyQuotationRowOrder(state, moveQuotationRows(rows, 'b', 6));
assert.equal(intoClosed.lines.find(line => line.id === 'b').room, 'Closed');
assert.equal(intoClosed.lines.length, state.lines.length);
assert.equal(intoClosed.lines.find(line => line.id === 'hidden'), hidden);

// Web sections move as a group while native single-header gestures retain data.
const sectionRows = moveQuotationRows(rows, 'hdr-Kitchen', 0);
assert.deepEqual(sectionRows.map(row => row.id), ['hdr-Kitchen', 'c', 'hdr-Bath', 'a', 'part', 'b', 'hdr-Closed']);
assert.deepEqual(applyQuotationRowOrder(state, sectionRows).lines.map(line => line.id), ['c', 'a', 'part', 'b', 'hidden']);
const closedFirst = moveQuotationRows(rows, 'hdr-Closed', 0);
assert.deepEqual(applyQuotationRowOrder(state, closedFirst).lines.map(line => line.id), ['hidden', 'a', 'part', 'b', 'c']);
const sectionLast = moveQuotationRows(rows, 'hdr-Bath', rows.length);
assert.deepEqual(sectionLast.map(row => row.id), ['hdr-Kitchen', 'c', 'hdr-Closed', 'hdr-Bath', 'a', 'part', 'b']);
const bounded = moveQuotationRows(rows, 'hdr-Closed', 2);
assert.deepEqual(bounded.map(row => row.id), ['hdr-Bath', 'a', 'part', 'b', 'hdr-Closed', 'hdr-Kitchen', 'c']);

// Native header drag now persists section order and collapsed lines as well.
const sections = applyQuotationRowOrder(state, [header('Closed'), header('Kitchen'), row(c), header('Bath'), row(a), row(part), row(b)]);
assert.deepEqual(sections.rooms, ['Closed', 'Kitchen', 'Bath']);
assert.deepEqual(sections.lines.map(line => line.id), ['hidden', 'c', 'a', 'part', 'b']);

// Keyboard/tap alternatives cannot detach included parts or cross a boundary.
assert.deepEqual(moveQuotationLine(state.lines, 'a', 1).map(line => line.id), ['b', 'a', 'part', 'c', 'hidden']);
assert.equal(moveQuotationLine(state.lines, 'part', -1), state.lines);
assert.equal(moveQuotationLine(state.lines, 'a', -1), state.lines);
assert.equal(moveQuotationRows(rows, 'part', 4), rows);
assert.equal(moveQuotationRows(rows, 'missing', 4), rows);
assert.equal(moveQuotationRows(rows, 'a', 0), rows);
assert.equal(applyQuotationRowOrder(state, rows), state);

// The save payload and reload use the ordered items array directly.
const saved = JSON.parse(JSON.stringify({ items: moved.lines, rooms: moved.rooms }));
assert.deepEqual(saved.items.map(line => line.id), ['b', 'c', 'a', 'part', 'hidden']);
assert.deepEqual(saved.rooms, ['Bath', 'Kitchen', 'Closed']);
console.log('Quotation ordering: cross-category/room movement, groups, collapsed data and keyboard boundaries passed');
