import assert from 'node:assert/strict';
import { filterValues, matchesFilter, toggleFilterValue } from '../src/utils/filters.ts';

assert.deepEqual(filterValues('a,b,a,all,'), ['a', 'b']);
assert.equal(toggleFilterValue('all', 'a'), 'a');
assert.equal(toggleFilterValue('a', 'b'), 'a,b');
assert.equal(toggleFilterValue('a,b', 'a'), 'b');
assert.equal(toggleFilterValue('b', 'b'), 'all');
assert.equal(toggleFilterValue('a,b', 'all'), 'all');
assert.equal(toggleFilterValue('', 'in_box', ''), 'in_box');
assert.equal(toggleFilterValue('in_box', 'in_box', ''), '');
assert.equal(matchesFilter('c', 'a,b'), false);
assert.equal(matchesFilter('b', 'a,b'), true);
assert.equal(matchesFilter('anything', 'all'), true);
console.log('Multi-choice toggling, clearing, legacy URLs and OR matching passed');
