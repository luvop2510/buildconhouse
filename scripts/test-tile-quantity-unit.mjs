import assert from 'node:assert/strict';
import test from 'node:test';
import { tileQuantityUnit } from '../src/components/tiles/tileQuantityUnit.ts';

test('catalog piece pricing maps to pieces, including imported pcs', () => {
  for (const unit of ['pcs', 'per piece', 'Piece', 'per tile', 'per-pcs']) assert.equal(tileQuantityUnit(unit), 'Pieces', unit);
});

test('square-foot pricing maps to boxes', () => {
  for (const unit of ['sqft', 'per square foot', null, '']) assert.equal(tileQuantityUnit(unit), 'Box', String(unit));
});
