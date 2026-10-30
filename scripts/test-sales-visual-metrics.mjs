import assert from 'node:assert/strict';
import { graphScale } from '../src/components/salesAnalytics/graphScale.ts';
import { averageForBucket, collectionProgress, currencyOrders, distributionTotal } from '../src/components/salesAnalytics/visualMetrics.ts';
assert.equal(collectionProgress(75,25),.75);
assert.equal(collectionProgress(0,100),0);
assert.equal(collectionProgress(100,0),1);
for (const pair of [[null,100],[100,undefined],[0,0],[-1,100],[100,-1],[Infinity,100],[100,NaN],[Number.MAX_VALUE,Number.MAX_VALUE]]) assert.equal(collectionProgress(...pair),null);
assert.equal(currencyOrders({orders:5},'INR','all'),null);
assert.equal(currencyOrders({orders:5},'RNB','third-floor'),5);
assert.equal(currencyOrders({orders:5,orders_inr:3,orders_rnb:2},'INR','all'),3);
assert.equal(currencyOrders({orders:5,orders_inr:3,orders_rnb:2},'RNB','all'),2);
assert.equal(currencyOrders({orders:5,orders_rnb:0},'RNB','all'),0);
assert.equal(currencyOrders({orders:5,orders_rnb:NaN},'RNB','all'),null);
assert.equal(averageForBucket(120,3),40);
for(const pair of [[null,3],[120,null],[120,0],[Infinity,3]])assert.equal(averageForBucket(...pair),null);
assert.equal(distributionTotal([80,20,0]),100);
for(const values of [[80,null],[80,undefined],[0,0],[-1,2],[Infinity,1],[],[Number.MAX_VALUE,Number.MAX_VALUE]])assert.equal(distributionTotal(values),null);
console.log('Sales visuals: truthful balances, complete distributions, currency-specific orders and averages; unknown values remain unavailable.');

for(const values of [[0,10,20],[-10,0,30],[null,undefined,NaN,Infinity],[0,0],[-Number.MAX_VALUE,Number.MAX_VALUE]]){
 const scale=graphScale(values);assert.ok(Number.isFinite(scale.zero)&&scale.zero>=0&&scale.zero<=100);
 for(const value of values.filter(Number.isFinite)){const position=scale.position(value);assert.ok(Number.isFinite(position)&&position>=0&&position<=100);}
}
assert.equal(graphScale([0,50],100).position(50),50);
assert.equal(graphScale([-10,30]).zero,25);
console.log('Graph scales: shared zero, signed values, unknown values, explicit comparison maximum and finite extreme geometry passed.');
