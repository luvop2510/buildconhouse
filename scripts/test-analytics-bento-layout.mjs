import assert from 'node:assert/strict';
import { squarify } from '../src/components/ui/analytics-bento-layout.ts';
const items = [{name:'Tiles',group:'ground-floor',v:60},{name:'Sanitary',group:'first-floor',v:30},{name:'Kitchen',group:'second-floor',v:10}];
const rects=squarify(items,0,0,300,180);
assert.equal(rects.length,3);
for(const [i,rect] of rects.entries()) {
 assert.ok(Math.abs(rect.w*rect.h/(300*180)-items[i].v/100)<1e-9);
 assert.ok(rect.x>=0&&rect.y>=0&&rect.x+rect.w<=300.00001&&rect.y+rect.h<=180.00001);
}
assert.deepEqual(squarify([{name:'Missing',group:'x',v:NaN},{name:'Zero',group:'y',v:0}],0,0,300,180),[]);
assert.deepEqual(squarify(items,0,0,0,180),[]);
console.log('Analytics Bento treemap keeps source proportions, bounds and empty-data handling.');
