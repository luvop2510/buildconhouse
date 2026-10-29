/** Date-only defaults follow the Kitchen business day in India, including around UTC midnight. */
export function kitchenToday(now = new Date()) {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}

/** Two calendar months, clamped only when the destination month has fewer days. */
export function kitchenProductionEnd(start?: string | null) {
  if (!start || !/^\d{4}-\d{2}-\d{2}$/.test(start)) return "";
  const [year, month, day] = start.split("-").map(Number);
  const target = new Date(Date.UTC(year, month + 1, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, last));
  return target.toISOString().slice(0, 10);
}
