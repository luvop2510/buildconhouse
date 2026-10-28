/** Timestamp bounds stay exact until a date control is explicitly changed. */
export function analyticsDateDisplay(value?: string, exclusiveEnd = false) {
 if (!value) return '';
 if (isAnalyticsCalendarDate(value)) return value;
 const timestamp = analyticsBoundary(value);
 if (timestamp == null) return '';
 return new Date(timestamp + 330 * 60_000 - (exclusiveEnd ? 1 : 0)).toISOString().slice(0, 10);
}
export function isAnalyticsCalendarDate(value?: string) {
 if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
 const parsed = new Date(`${value}T00:00:00.000Z`);
 return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
export function analyticsBoundary(value?: string, inclusiveDateEnd = false): number | null {
 if (isAnalyticsCalendarDate(value)) return Date.parse(`${value}T00:00:00+05:30`) + (inclusiveDateEnd ? 86_400_000 : 0);
 if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !isAnalyticsCalendarDate(value.slice(0, 10))) return null;
 const parsed = Date.parse(value);
 return Number.isFinite(parsed) ? parsed : null;
}
export function validAnalyticsRange(from?: string, to?: string) {
 const start = analyticsBoundary(from);
 const end = analyticsBoundary(to, true);
 return start != null && end != null && start < end;
}
