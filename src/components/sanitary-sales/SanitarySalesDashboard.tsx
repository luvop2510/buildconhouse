import { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  sanitarySalesApi, type SanitaryBrand, type SanitaryFilters,
  type SanitaryMetrics, type SanitaryReport, type SanitarySort,
} from '@/src/api/sanitarySales';
import { SANITARY_FLOOR_ID } from '@/src/constants/floors';
import { AdminPage } from '@/src/components/AdminPage';
import { Text } from '@/src/components/AppText';
import { subscribeAnalyticsRevocation } from '@/src/components/salesAnalytics/readCache';
import { useAnalyticsRead } from '@/src/components/salesAnalytics/useAnalytics';
import { Button } from '@/src/design/components';
import { color, font, radius, space } from '@/src/design/tokens';
import { subscribeApiCacheInvalidation } from '@/src/api/client';
import { downloadApiFile } from '@/src/utils/downloadFile';
import { InlineError, LedgerRow, LoadNotice } from './LedgerUI';
import { ReportChoice, SharedSanitaryFilters } from './SanitaryFilters';
import { ReportResults } from './ReportResults';
import { REPORT_GROUPS, amount, type ReportDefinition } from './reportPresentation';

const TITLE = 'Sanitary Floor Sales Data';
const ALL_COMPANIES = { id: '', name: 'All companies' };
const PRODUCT_SORTS: { id: SanitarySort; name: string }[] = [
  { id: 'quantity', name: 'Best by quantity' },
  { id: 'value', name: 'Best by sales value' },
];
const INTERIOR_SORTS: { id: SanitarySort; name: string }[] = [
  { id: 'orders', name: 'Most placed orders' },
  { id: 'value', name: 'Highest order value' },
  { id: 'customers', name: 'Most customers' },
];

export default function SanitarySalesDashboard() {
  const [filters, setFilters] = useState<SanitaryFilters>({ preset: 'all_time', value_basis: 'offer' });
  const [active, setActive] = useState<SanitaryReport>();
  const brandRead = useAnalyticsRead('/sanitary-sales/brands', sanitarySalesApi.brands);

  return <AdminPage title={TITLE}>
    <SharedSanitaryFilters filters={filters}
      onDateChange={next => setFilters(old => ({ value_basis: old.value_basis, ...next }))}
      onBasisChange={next => setFilters(old => ({ ...old, value_basis: next }))} />
    <View style={styles.groups} testID="sanitary-reports">
      {REPORT_GROUPS.map(group => <View key={group.label} style={styles.group}>
        <Text accessibilityRole="header" aria-level={2} style={styles.groupLabel}>{group.label}</Text>
        <View style={styles.surface}>
          {group.reports.map((report, index) => <ReportSection
            key={report.id} report={report} filters={filters} open={active === report.id} divided={index > 0}
            brandRead={brandRead} onToggle={() => setActive(current => current === report.id ? undefined : report.id)}
          />)}
        </View>
      </View>)}
    </View>
  </AdminPage>;
}

function ReportSection({ report, filters, open, onToggle, brandRead, divided }: {
  report: ReportDefinition; filters: SanitaryFilters; open: boolean; onToggle: () => void;
  brandRead: ReturnType<typeof useAnalyticsRead<{ items: SanitaryBrand[] }>>; divided: boolean;
}) {
  const [brand, setBrand] = useState(ALL_COMPANIES.id);
  const [sort, setSort] = useState(report.defaultSort);
  const params = { ...filters, brand_id: brand, sort };
  const filterKey = sanitarySalesApi.reportKey(report.id, params);
  const [summary, setSummary] = useState<{ key: string; totals: SanitaryMetrics } | null>(null);
  const receiveTotals = useCallback((totals: SanitaryMetrics | null) => {
    setSummary(totals ? { key: filterKey, totals } : null);
  }, [filterKey]);
  useEffect(() => subscribeAnalyticsRevocation(() => setSummary(null)), []);
  useEffect(() => subscribeApiCacheInvalidation(() => setSummary(null)), []);

  const options = [ALL_COMPANIES, ...(brandRead.data?.items || [])];
  const selectedCompany = options.find(option => option.id === brand);
  if (!selectedCompany) options.push({ id: brand, name: 'Selected company' });
  const selectedSorts = report.id === 'products' ? PRODUCT_SORTS : INTERIOR_SORTS;
  const currentSummary = summary?.key === filterKey ? summary.totals : null;
  return <View style={divided ? styles.divided : undefined}>
    <LedgerRow section title={report.label} label={report.title} open={open}
      subtitle={!open && brand ? selectedCompany?.name : undefined}
      displayValue={!open && currentSummary ? amount(currentSummary.value) : undefined}
      valueNote={!open && currentSummary?.value != null && currentSummary.missing_value_lines > 0 ? 'Recorded subtotal' : undefined}
      onPress={onToggle} testID={`sanitary-report-${report.id}`} />
    {open && <View style={styles.section}>
      <View style={styles.toolbar}>
        <View style={styles.reportFilters}>
          <ReportChoice label="Company" value={brand} options={options} onChange={setBrand} testID={`sanitary-brand-${report.id}`} />
          {sort && <ReportChoice label={report.id === 'products' ? 'Rank by' : 'Sort by'}
            value={sort} options={selectedSorts} onChange={setSort} testID={`sanitary-sort-${report.id}`} />}
        </View>
        <ExportExcel report={report} filters={params} brandName={selectedCompany?.name || 'Company'} />
      </View>
      {!brandRead.data && <LoadNotice section="companies" loading={brandRead.loading} error={brandRead.error} retry={brandRead.refresh} />}
      <ReportResults key={filterKey} report={report.id} filters={params} onTotals={receiveTotals} />
    </View>}
  </View>;
}

function exportName(report: ReportDefinition, filters: SanitaryFilters, brandName: string) {
  const range = filters.preset === 'custom'
    ? `${filters.date_from}_to_${filters.date_to}`
    : filters.preset;
  return `Sanitary_${report.filename}_${brandName}_${range}_${filters.value_basis === 'mrp' ? 'MRP' : 'Offer_Price'}.xlsx`
    .replace(/\s+/g, '_').replace(/[\/:*?"<>|]/g, '');
}

function ExportExcel({ report, filters, brandName }: { report: ReportDefinition; filters: SanitaryFilters; brandName: string }) {
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const download = async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await downloadApiFile(sanitarySalesApi.exportPath(report.id, filters), exportName(report, filters, brandName),
        'Excel report', SANITARY_FLOOR_ID, setError);
    } catch {
      setError('Could not export this report. Try again.');
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  return <View style={styles.export}>
    <Button label={busy ? 'Preparing Excel…' : 'Export Excel'} variant="secondary" size="sm" icon="download"
      testID={`sanitary-export-${report.id}`} loading={busy} onPress={() => void download()} />
    {error && <InlineError message={error} />}
  </View>;
}

const styles = StyleSheet.create({
  groups: { gap: space.x4 },
  group: { gap: space.x2 },
  groupLabel: { color: color.ink, fontFamily: font.semibold, fontSize: 18, fontWeight: '600', lineHeight: 26 },
  surface: { borderColor: color.line, borderWidth: 1, borderRadius: radius.lg, backgroundColor: color.surface },
  divided: { borderTopColor: color.line, borderTopWidth: 1 },
  section: { paddingHorizontal: space.x4, paddingBottom: space.x4, gap: space.x3 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: space.x3 },
  reportFilters: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: space.x3, maxWidth: '100%' },
  export: { gap: space.x2, flexShrink: 1 },
});
