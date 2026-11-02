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

/** Translate a native edit in the displayed string back to a raw amount and caret. */
export function editKitchenAmount(previous: string, next: string, caret: number): { value: string; caret: number } {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let oldEnd = previous.length;
  let newEnd = next.length;
  while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
  // Backspacing a separator should remove the digit before it, not reinsert the separator.
  if (previous.slice(start, oldEnd) === ',' && start === newEnd && caret === oldEnd && start > 0) {
    next = next.slice(0, start - 1) + next.slice(start);
    start--;
    newEnd--;
  }
  const value = kitchenAmountInput(next);
  const rawCaret = kitchenAmountInput(next.slice(0, newEnd)).length;
  const formatted = formatKitchenAmount(value);
  let position = 0;
  let count = 0;
  while (position < formatted.length && count < rawCaret) {
    if (formatted[position] !== ',') count++;
    position++;
  }
  return { value, caret: position };
}
