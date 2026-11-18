const indiaOffsetMs = 330 * 60_000;
const dayMs = 24 * 60 * 60_000;
export const indiaTimeZone = "Asia/Kolkata";

export function followupCalendarDay(value: Date | string): string {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp + indiaOffsetMs).toISOString().slice(0, 10) : "";
}

export function addCalendarDays(day: string, days: number): string {
  return new Date(Date.parse(day + "T00:00:00Z") + days * dayMs).toISOString().slice(0, 10);
}

export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + "T00:00:00Z");
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function followupDaysFromToday(value: Date | string, now = new Date()): number {
  return (Date.parse(followupCalendarDay(value)) - Date.parse(followupCalendarDay(now))) / dayMs;
}

export function followupDateLabel(value: string, withTime = false): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return date.toLocaleString("en-IN", {
    timeZone: indiaTimeZone, day: "numeric", month: "short", year: "numeric",
    ...(withTime ? { hour: "numeric", minute: "2-digit" } : {}),
  });
}
