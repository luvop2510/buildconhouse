/** Normalize before subtracting so finite large/negative values cannot overflow SVG geometry. */
export function graphScale(values:(number|null|undefined)[],maxValue?:number) {
 const valid=values.filter((value):value is number=>value!=null&&Number.isFinite(value));
 const minimum=Math.min(0,...valid),maximum=Math.max(0,maxValue!=null&&Number.isFinite(maxValue)?maxValue:0,...valid);
 const normalizer=Math.max(1,Math.abs(minimum),Math.abs(maximum));
 const lower=minimum/normalizer,span=maximum/normalizer-lower||1;
 return {zero:(-lower/span)*100,position:(value:number)=>(value/normalizer-lower)/span*100};
}
