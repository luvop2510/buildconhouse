/** Analytics windows are UTC and use an exclusive end, matching the API. */
export function calendarDay(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function customDateRange(from: string, to: string): { dateFrom: string; dateTo: string } | null {
  const start = calendarDay(from);
  const end = calendarDay(to);
  if (!start || !end || start > end) return null;
  end.setUTCDate(end.getUTCDate() + 1);
  // Order timestamps are stored as Python ISO UTC strings. Match their
  // midnight representation so indexed string comparisons include midnight.
  const boundary = (date: Date) => date.toISOString().replace(".000Z", "+00:00");
  return { dateFrom: boundary(start), dateTo: boundary(end) };
}

export function inclusiveEndDay(value: string | null): string {
  if (!value) return "";
  const end = new Date(value);
  if (!Number.isFinite(end.getTime())) return "";
  // Old saved ranges used 23:59:59 rather than an exclusive midnight.
  if (end.getUTCHours() === 0 && end.getUTCMinutes() === 0 && end.getUTCSeconds() === 0 && end.getUTCMilliseconds() === 0) {
    end.setUTCDate(end.getUTCDate() - 1);
  }
  return end.toISOString().slice(0, 10);
}

export function rangeLabel(from: string | null, to: string | null): string {
  if (!from || !to || !Number.isFinite(Date.parse(from)) || !Number.isFinite(Date.parse(to))) return "Custom range";
  const format = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
  return `${format(from.slice(0, 10))} – ${format(inclusiveEndDay(to))}`;
}
