import { useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  sanitarySalesApi, type SanitaryBrand, type SanitaryFilters,
  type OverviewFilters, type SanitaryReport, type SanitarySort,
} from '@/src/api/sanitarySales';
import { SANITARY_FLOOR_ID } from '@/src/constants/floors';
import { AdminPage } from '@/src/components/AdminPage';
import { Text } from '@/src/components/AppText';
import { useAnalyticsRead } from '@/src/components/salesAnalytics/useAnalytics';
import { Button } from '@/src/design/components';
import { color, font, radius, space } from '@/src/design/tokens';
import { downloadApiFile } from '@/src/utils/downloadFile';
import { InlineError, LoadNotice } from './LedgerUI';
import { ReportChoice, SharedSanitaryFilters } from './SanitaryFilters';
import { ReportResults } from './ReportResults';
import { SanitaryOverview } from './SanitaryOverview';
import { REPORT_GROUPS, type ReportDefinition } from './reportPresentation';

const TITLE = 'Sanitary Floor Sales Data';
const ALL_COMPANIES = { id: '', name: 'All brands' };
const OTHER_COMPANIES = { id: 'other', name: 'Other' };
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
  const [filters, setFilters] = useState<OverviewFilters>({
    preset: 'all_time', value_basis: 'offer', architect_sort: 'value', product_sort: 'quantity',
  });
  const [showReports, setShowReports] = useState(false);
  const [active, setActive] = useState<SanitaryReport>();
  const brandRead = useAnalyticsRead('/sanitary-sales/brands', sanitarySalesApi.brands);
  const brands = [ALL_COMPANIES, ...(brandRead.data?.items || []).filter(brand => brand.id !== 'other'), OTHER_COMPANIES];
  const { preset, date_from, date_to, value_basis, brand_id } = filters;
  const reportFilters = { preset, date_from, date_to, value_basis, brand_id };
  const report = REPORT_GROUPS.flatMap(group => group.reports).find(row => row.id === active);

  return <AdminPage key={showReports ? 'reports' : 'overview'} title={TITLE}>
    <View style={styles.tabs}>
      <Pressable accessibilityRole="button" aria-pressed={!showReports} style={[styles.reportTab, !showReports && styles.selectedTab]}
        onPress={() => setShowReports(false)}><Text style={styles.tabLabel}>Overview</Text></Pressable>
      <Pressable accessibilityRole="button" aria-pressed={showReports} style={[styles.reportTab, showReports && styles.selectedTab]}
        onPress={() => setShowReports(true)}><Text style={styles.tabLabel}>Detailed reports</Text></Pressable>
    </View>
    <View style={styles.reportFilters}>
    <SharedSanitaryFilters filters={filters}
      onDateChange={next => setFilters(old => ({ ...old, date_from: undefined, date_to: undefined, ...next }))}
      onBasisChange={next => setFilters(old => ({ ...old, value_basis: next }))} />
    {!showReports && <ReportChoice label="Brand" value={brand_id || ''} options={brands}
      onChange={brand_id => setFilters(old => ({ ...old, brand_id }))} testID="sanitary-overview-brand" />}
    </View>
    {showReports ? <View style={styles.groups} testID="sanitary-reports">
      <View style={styles.tabs}>
        {REPORT_GROUPS.flatMap(group => group.reports).map(row => <Pressable key={row.id}
          testID={`sanitary-report-${row.id}`} accessibilityRole="button"
          accessibilityState={{ expanded: active === row.id }} aria-expanded={active === row.id}
          style={[styles.reportTab, active === row.id && styles.selectedTab]}
          onPress={() => setActive(current => current === row.id ? undefined : row.id)}>
          <Text style={styles.tabLabel}>{row.title}</Text>
        </Pressable>)}
      </View>
      {report ? <View style={styles.surface}><ReportSection
        key={`${report.id}:${brand_id || ''}`} report={report} filters={reportFilters} brandRead={brandRead}
        initialSort={report.id === 'products' ? filters.product_sort : report.defaultSort}
      /></View> : null}
    </View> : <>
      {!brandRead.data && brandRead.error ? <LoadNotice section="brands" loading={false}
        error={brandRead.error} retry={brandRead.refresh} /> : null}
      <SanitaryOverview filters={filters} setFilters={next => setFilters(old => ({ ...old, ...next }))}
        onProducts={() => { setActive('products'); setShowReports(true); }}
        onReports={() => setShowReports(true)} />
    </>}
  </AdminPage>;
}

function ReportSection({ report, filters, initialSort, brandRead }: {
  report: ReportDefinition; filters: SanitaryFilters; initialSort?: SanitarySort;
  brandRead: ReturnType<typeof useAnalyticsRead<{ items: SanitaryBrand[] }>>;
}) {
  const [brand, setBrand] = useState(filters.brand_id || '');
  const [sort, setSort] = useState(initialSort);
  const params = { ...filters, brand_id: brand, sort };
  const filterKey = sanitarySalesApi.reportKey(report.id, params);
  const options = [ALL_COMPANIES, ...(brandRead.data?.items || []).filter(brand => brand.id !== 'other'), OTHER_COMPANIES];
  const selectedCompany = options.find(option => option.id === brand);
  if (!selectedCompany) options.push({ id: brand, name: 'Selected company' });
  const selectedSorts = report.id === 'products' ? PRODUCT_SORTS : INTERIOR_SORTS;
  return <View style={styles.section}>
      <Text accessibilityRole="header" aria-level={2} style={styles.groupLabel}>{report.title}</Text>
      <View style={styles.toolbar}>
        <View style={styles.reportFilters}>
          <ReportChoice label="Company" value={brand} options={options} onChange={setBrand} testID={`sanitary-brand-${report.id}`} />
          {sort && <ReportChoice label={report.id === 'products' ? 'Rank by' : 'Sort by'}
            value={sort} options={selectedSorts} onChange={setSort} testID={`sanitary-sort-${report.id}`} />}
        </View>
        <ExportExcel report={report} filters={params} brandName={selectedCompany?.name || 'Company'} />
      </View>
      {!brandRead.data && <LoadNotice section="companies" loading={brandRead.loading} error={brandRead.error} retry={brandRead.refresh} />}
      <ReportResults key={filterKey} report={report.id} filters={params} />
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
  groupLabel: { color: color.ink, fontFamily: font.semibold, fontSize: 18, fontWeight: '600', lineHeight: 26 },
  surface: { borderColor: color.line, borderWidth: 1, borderRadius: radius.lg, backgroundColor: color.surface },
  section: { padding: space.x4, gap: space.x3 },
  tabs: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2 },
  reportTab: { minHeight: 44, justifyContent: 'center', borderRadius: radius.md, borderWidth: 1,
    borderColor: color.line, backgroundColor: color.surface, paddingHorizontal: space.x3, paddingVertical: space.x2 },
  selectedTab: { backgroundColor: color.accentTint },
  tabLabel: { color: color.action, fontWeight: '500', fontSize: 14, flexShrink: 1 },
  toolbar: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: space.x3 },
  reportFilters: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: space.x3, maxWidth: '100%' },
  export: { gap: space.x2, flexShrink: 1 },
});
