import assert from 'node:assert/strict';
import { appTextFamily } from '../src/components/appTextFamily.ts';

assert.equal(appTextFamily(), 'Inter-Regular');
assert.equal(appTextFamily(null), 'Inter-Regular');
for (const weight of ['normal', '100', '200', '300', '400', 400]) assert.equal(appTextFamily({ fontWeight: weight }), 'Inter-Regular');
for (const [fontWeight, family] of [['500', 'Inter-Medium'], [500, 'Inter-Medium'], ['600', 'Inter-SemiBold'], [600, 'Inter-SemiBold'], ['700', 'Inter-Bold'], ['800', 'Inter-Bold'], [900, 'Inter-Bold'], ['bold', 'Inter-Bold']]) assert.equal(appTextFamily({ fontWeight }), family);
assert.equal(appTextFamily({ fontFamily: 'Inter-Medium', fontWeight: '700' }), 'Inter-Medium', 'explicit token style wins');
assert.equal(appTextFamily({ fontFamily: 'feather' }), 'feather', 'icon font is preserved');
console.log('Native app text defaults: 18 font-family/weight cases passed.');
