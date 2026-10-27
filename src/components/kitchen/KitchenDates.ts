/** Date-only defaults follow the Kitchen business day in India, including around UTC midnight. */
export function kitchenToday(now = new Date()) {
  return new Date(now.getTime() + 330 * 60_000).toISOString().slice(0, 10);
}
