import type { SanitaryReport, SanitarySort, SanitaryValueBasis } from '@/src/api/sanitarySales';
import { statusTone } from '@/src/design/tokens';

export type ReportDefinition = {
  id: SanitaryReport;
  label: string;
  title: string;
  filename: string;
  defaultSort?: SanitarySort;
};

export const REPORT_GROUPS: { label: string; reports: ReportDefinition[] }[] = [
  {
    label: 'Pending quotations',
    reports: [
      { id: 'pending-company', label: 'By company', title: 'Pending quotations by company', filename: 'Pending_Company' },
      { id: 'pending-interior', label: 'By interior or architect', title: 'Pending quotations by interior or architect', filename: 'Pending_Interior' },
    ],
  },
  {
    label: 'Placed orders',
    reports: [
      { id: 'placed-company', label: 'By company', title: 'Placed orders by company', filename: 'Placed_Company' },
      { id: 'placed-interior', label: 'By interior or architect', title: 'Placed orders by interior or architect', filename: 'Placed_Interior' },
    ],
  },
  {
    label: 'Performance',
    reports: [
      { id: 'products', label: 'Product rankings', title: 'Product performance', filename: 'Product_Performance', defaultSort: 'quantity' },
      { id: 'interior-orders', label: 'Orders by interior or architect', title: 'Number of placed orders by interior or architect', filename: 'Interior_Orders', defaultSort: 'orders' },
    ],
  },
];

export const basisLabels: Record<SanitaryValueBasis, string> = { mrp: 'MRP', offer: 'Offer Price' };

const rupees = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2 });
const numbers = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 8 });
const dates = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });

export function amount(value: number | null | undefined) {
  return value == null ? 'Unavailable' : rupees.format(value);
}

export function count(value: number, singular: string, plural = `${singular}s`) {
  return `${numbers.format(value)} ${value === 1 ? singular : plural}`;
}

export function quantity(value: number | null | undefined, unit?: string | null) {
  if (value == null) return 'Quantity unavailable';
  return `${numbers.format(value)} ${unit || '(unit unavailable)'}`;
}

export function day(value: string | null) {
  if (!value) return 'Date unavailable';
  const parsed = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) ? dates.format(parsed) : 'Date unavailable';
}

export function statusLabel(status: string | null) {
  if (!status) return 'Status unavailable';
  return statusTone[status]?.label || status.replace(/[_-]/g, ' ').replace(/^./, first => first.toUpperCase());
}

export function documentNoun(report: SanitaryReport) {
  return report.startsWith('pending-') ? 'quotation' : 'order';
}

export function identityText(...bits: (string | null | undefined)[]) {
  return bits.filter(Boolean).join(' · ');
}
