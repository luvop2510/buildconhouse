/** Group the integer part for display without changing the decimal draft or its precision. */
export function formatKitchenAmount(value: string): string {
  const raw = value.replace(/,/g, "");
  const match = /^(\d+)(\..*)?$/.exec(raw);
  if (!match) return raw;
  const integer = match[1];
  const prefix = integer.slice(0, -3);
  const grouped = prefix ? `${prefix.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${integer.slice(-3)}` : integer;
  return grouped + (match[2] || "");
}

export function kitchenAmountInput(value: string): string {
  return value.replace(/,/g, "");
}
