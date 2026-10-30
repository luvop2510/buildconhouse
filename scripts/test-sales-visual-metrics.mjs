import assert from 'node:assert/strict';
import { collectionProgress } from '../src/components/salesAnalytics/visualMetrics.ts';
assert.equal(collectionProgress(75,25),.75);
assert.equal(collectionProgress(0,100),0);
assert.equal(collectionProgress(100,0),1);
for (const pair of [[null,100],[100,undefined],[0,0],[-1,100],[100,-1],[Infinity,100],[100,NaN],[Number.MAX_VALUE,Number.MAX_VALUE]]) assert.equal(collectionProgress(...pair),null);
console.log('Sales visual metrics: complete comparable balances only; unknown, empty and invalid amounts stay unavailable.');
