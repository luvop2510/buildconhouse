/** The company overview uses INR; RNB belongs to an explicit Furniture view. */
export function analyticsCurrency(floorId?: string): 'INR' | 'RNB' {
  return floorId === 'third-floor' ? 'RNB' : 'INR';
}

export function analyticEntityAmount(row: { sales?: number | null; sales_rnb?: number | null }, floorId?: string) {
  return analyticsCurrency(floorId) === 'RNB' ? row.sales_rnb : row.sales;
}

/** Preserve a source record's own currency; remove irrelevant aggregate columns. */
export function visibleAnalyticsFields(row: Record<string, unknown>, floorId?: string) {
  const furniture = analyticsCurrency(floorId) === 'RNB';
  const aggregate = Object.prototype.hasOwnProperty.call(row, 'sales_rnb');
  const inrFields = new Set(['sales', 'average_order_value', 'collected', 'outstanding', 'orders_inr', 'previous_sales', 'change_pct']);
  return Object.entries(row).filter(([key]) => {
    if (key.endsWith('_rnb')) return furniture;
    return !(furniture && aggregate && inrFields.has(key));
  });
}

/** A drilldown currency cannot silently carry into a different business unit. */
export function analyticsNextFilters(current: Record<string,string>, next: Record<string,string>) {
  return next.floor_id !== undefined && next.floor_id !== current.floor_id && next.currency === undefined ? {...next,currency:''} : next;
}
