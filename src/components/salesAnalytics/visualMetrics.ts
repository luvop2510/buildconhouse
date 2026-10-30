/** Only comparable, complete balances can produce a progress indicator. */
export function collectionProgress(collected: number | null | undefined, outstanding: number | null | undefined) {
 if (collected == null || outstanding == null || !Number.isFinite(collected) || !Number.isFinite(outstanding) || collected < 0 || outstanding < 0) return null;
 const total = collected + outstanding;
 return Number.isFinite(total) && total > 0 ? collected / total : null;
}

/** Overall order counts cannot stand in for one currency's orders. */
export function currencyOrders(point: {orders:number;orders_inr?:number;orders_rnb?:number}, currency:string, floorId:string) {
 const value=currency==='RNB'?point.orders_rnb:point.orders_inr;
 const count=value??(floorId!=='all'?point.orders:undefined);
 return count!=null&&Number.isFinite(count)&&count>=0?count:null;
}

export function averageForBucket(amount:number|null|undefined, count:number|null) {
 return amount!=null&&Number.isFinite(amount)&&count!=null&&count>0?amount/count:null;
}

/** A partial distribution must not be drawn as a complete circle. */
export function distributionTotal(values:(number|null|undefined)[]) {
 if (!values.length||values.some(value=>value==null||!Number.isFinite(value)||value<0)) return null;
 const total=values.reduce<number>((sum,value)=>sum+value!,0);
 return Number.isFinite(total)&&total>0?total:null;
}
