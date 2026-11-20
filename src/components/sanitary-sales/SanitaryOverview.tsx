import { useState, type ReactNode } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { Pressable, StyleSheet, View, useWindowDimensions, type DimensionValue } from 'react-native';
import {
  sanitarySalesApi, type OverviewFilters, type OverviewSection, type SanitaryMetrics, type SanitaryOverview as OverviewData,
} from '@/src/api/sanitarySales';
import { Text } from '@/src/components/AppText';
import { ProductImage } from '@/src/components/ProductImage';
import { useAnalyticsRead } from '@/src/components/salesAnalytics/useAnalytics';
import { Button, Txt } from '@/src/design/components';
import { useBp } from '@/src/design/responsive';
import { webCursor } from '@/src/design/shared';
import { color, font, layout, radius, space } from '@/src/design/tokens';
import { EmptyNotice, LoadNotice } from './LedgerUI';
import { ActivityRow, CustomerActivity, OverviewRecords, type RecordSelection } from './OverviewRecords';
import { ReportChoice } from './SanitaryFilters';
import { amount, basisLabels, count, identityText, quantity } from './reportPresentation';

const architectSorts = [
  { id: 'value', name: 'Placed order value' },
  { id: 'orders', name: 'Order count' },
  { id: 'customers', name: 'Customer count' },
] as const;
const productSorts = [
  { id: 'quantity', name: 'Quantity sold' },
  { id: 'value', name: 'Sales value' },
] as const;

const number = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 1 });
function shortAmount(value: number | null) {
  if (value == null) return amount(value);
  if (Math.abs(value) >= 10000000) return `₹${number.format(value / 10000000)}Cr`;
  if (Math.abs(value) >= 100000) return `₹${number.format(value / 100000)}L`;
  return amount(value);
}
function subtotal(value: Pick<SanitaryMetrics, 'value' | 'missing_value_lines'>) {
  return value.value != null && value.missing_value_lines > 0 ? 'Recorded subtotal' : null;
}
function pct(value: number | null) {
  return value == null ? 'Unavailable' : `${number.format(value)}%`;
}

export function SanitaryOverview({ filters, setFilters, onProducts, onReports }: {
  filters: OverviewFilters;
  setFilters: (filters: Partial<OverviewFilters>) => void;
  onProducts: () => void;
  onReports: () => void;
}) {
  const read = useAnalyticsRead(sanitarySalesApi.overviewKey(filters), signal => sanitarySalesApi.overview(filters, signal));
  const [selection, setSelection] = useState<RecordSelection>();
  const [moreBrands, setMoreBrands] = useState(false);
  const [moreArchitects, setMoreArchitects] = useState(false);
  const { isDesktop, isTabletLandscape } = useBp();
  const { width, fontScale } = useWindowDimensions();
  const wide = (isDesktop || isTabletLandscape) && fontScale <= 1.3;
  const open = (section: OverviewSection, title: string, groupId?: string) => setSelection({ section, title, groupId });
  const data = read.data;
  if (!data) return <LoadNotice section="sales overview" loading={read.loading} error={read.error} retry={read.refresh} />;
  const maxBrandValue = Math.max(0, ...data.brands.map(row => row.placed_value || 0));
  return <View style={styles.overview} testID="sanitary-overview">
    {read.error ? <LoadNotice section="sales overview" loading={false} error={read.error} retry={read.refresh} /> : null}
    {read.refreshing ? <View accessibilityLiveRegion="polite"><Txt v="caption" tone="mid">Updating sales overview…</Txt></View> : null}
    <SalesMetrics data={data} columns={wide ? 4 : width >= 360 && fontScale <= 1.3 ? 2 : 1} onSelect={open} />
    <Panel title="Sales pipeline" subtitle="Stages can overlap. A delivered order can still have an unpaid balance.">
      <View style={styles.grid}>
        {data.pipeline.map(stage => <Metric key={stage.id} label={stage.name} id={`stage-${stage.id}`}
          value={String(stage.document_count)}
          note={identityText(count(stage.customer_count, 'customer'),
            stage.value == null ? null : amount(stage.value), subtotal(stage))}
          style={wide ? styles.pipelineWide : styles.pipelineNarrow}
          onPress={() => open(stage.id, stage.name)} />)}
      </View>
    </Panel>
    <View style={[styles.columns, wide && styles.columnsWide]}>
      <Panel title="Brand performance" paired={wide} subtitle={`Product-line values · ${basisLabels[filters.value_basis]}`}>
        {data.brands.length ? (moreBrands ? data.brands : data.brands.slice(0, 5)).map(brand => {
          const barWidth = maxBrandValue && brand.placed_value ? Math.max(0, brand.placed_value) / maxBrandValue : 0;
          const units = brand.quantities.map(value => quantity(value.quantity, value.unit)).join(' · ');
          return <RankedRow key={brand.id} name={brand.name} value={amount(brand.placed_value)}
            onPress={() => open('brand', brand.name, brand.id)} testID={`sanitary-overview-brand-row-${brand.id}`}>
            <Txt v="caption" tone="mid">{identityText(`${amount(brand.pending_value)} pending`,
              count(brand.order_count, 'order'), brand.share == null ? null : `${pct(brand.share)} of placed value`, units)}</Txt>
            {barWidth > 0 && <View aria-hidden style={styles.track}>
              <View style={[styles.bar, { width: `${barWidth * 100}%` }]} />
            </View>}
          </RankedRow>;
        }) : <EmptyNotice>No brand activity matches these filters.</EmptyNotice>}
        {data.brands.length > 5 && <Button size="sm" variant="ghost"
          label={moreBrands ? 'Show fewer brands' : 'Show all brands'} onPress={() => setMoreBrands(value => !value)} />}
      </Panel>
      <Panel title="Architect & interior performance" paired={wide}
        action={<ReportChoice label="Sort by" value={filters.architect_sort} options={architectSorts}
          onChange={architect_sort => setFilters({ architect_sort })} testID="sanitary-overview-architect-sort" />}>
        {data.architects.length ? (moreArchitects ? data.architects : data.architects.slice(0, 5)).map(row =>
          <RankedRow key={row.id} name={row.name} value={amount(row.order_value)}
            onPress={() => open('architect', row.name, row.id)} testID={`sanitary-overview-architect-${row.id}`}>
            {row.type ? <Txt v="caption" tone="mid">{row.type === 'interior_designer' ? 'Interior designer' : 'Architect'}</Txt> : null}
            <Txt v="caption" tone="mid">{count(row.customer_count, 'customer')} · {count(row.order_count, 'placed order')}</Txt>
            <Txt v="caption" tone="mid">{row.draft_customers} draft · {row.pending_customers} pending
              {row.outstanding == null ? '' : ` · ${amount(row.outstanding)} outstanding`}</Txt>
          </RankedRow>) : <EmptyNotice>No architect or interior activity matches these filters.</EmptyNotice>}
        {data.architects.length > 5 && <Button size="sm" variant="ghost"
          label={moreArchitects ? 'Show fewer architects' : 'Show all architects'} onPress={() => setMoreArchitects(value => !value)} />}
      </Panel>
    </View>
    <View style={[styles.columns, wide && styles.columnsWide]}>
      <Panel title="Needs attention" paired={wide}>
        {data.attention.length ? data.attention.slice(0, 5).map(row =>
          <CustomerActivity key={row.id} customer={row} />)
          : <EmptyNotice>No priority actions match these filters.</EmptyNotice>}
        {data.attention.length > 0 && <Button label="View all priority actions" variant="secondary" size="sm"
          onPress={() => open('attention', 'Needs attention')} />}
      </Panel>
      <Panel title="Payment collection" paired={wide} subtitle="Recorded order balances and payment due dates">
        <View style={styles.grid}>
          {data.payments.aging.map(bucket => <View key={bucket.id} style={styles.aging}>
            <Txt v="caption" tone="mid">{bucket.name}</Txt>
            <Txt v="money">{amount(bucket.value)}</Txt>
            <Txt v="caption">{count(bucket.order_count, 'order')}</Txt>
          </View>)}
        </View>
        {data.payments.items.length ? data.payments.items.slice(0, 5).map(row => <ActivityRow key={row.id} row={row} />)
          : <EmptyNotice>No recorded outstanding payments match these filters.</EmptyNotice>}
        <View style={styles.grid}>
          <Button size="sm" variant="secondary" label="All outstanding payments" onPress={() => open('outstanding', 'Outstanding payments')} />
          <Button size="sm" variant="secondary" label="Delivered but unpaid" onPress={() => open('delivered_unpaid', 'Delivered but unpaid')} />
        </View>
      </Panel>
    </View>
    <Panel title="Top products" subtitle={`Placed orders · ${basisLabels[filters.value_basis]}`}
      action={<ReportChoice label="Rank by" value={filters.product_sort} options={productSorts}
        onChange={product_sort => setFilters({ product_sort })} testID="sanitary-overview-product-sort" />}>
      {data.products.length ? data.products.map(row => <View key={row.id} style={styles.product}
        testID={`sanitary-overview-product-${row.id}`}>
        {row.image_url ? <ProductImage source={row.image_url} accessibilityLabel={`${row.name} product photo`}
          style={styles.image} borderRadius={radius.sm} disableSkeleton /> : null}
        <View style={styles.productName}>
          <Txt v="rowTitle">{row.name}</Txt>
          <Txt v="caption" tone="mid">{identityText(row.brand, row.sku, row.finish, row.size)}</Txt>
        </View>
        <View style={styles.productAmount}>
          <Txt v="money">{amount(row.value)}</Txt>
          <Txt v="caption" tone="mid">{quantity(row.quantity, row.unit)}</Txt>
          {subtotal(row) ? <Txt v="caption" tone="mid">{subtotal(row)}</Txt> : null}
        </View>
      </View>) : <EmptyNotice>No sold products match these filters.</EmptyNotice>}
      <Button label="Complete product analysis" size="sm" variant="secondary" icon="arrow-right" onPress={onProducts} />
    </Panel>
    <Panel title="Detailed reports" subtitle="Six reports with supporting records and Excel downloads.">
      <Button label="Open detailed reports" size="sm" variant="secondary" icon="arrow-right" onPress={onReports} />
    </Panel>
    {data.notes.map(note => <Txt key={note} v="caption" tone="mid">{note}</Txt>)}
    {selection ? <OverviewRecords key={`${selection.section}:${selection.groupId || ''}`}
      selection={selection} filters={filters} onClose={() => setSelection(undefined)} /> : null}
  </View>;
}

function SalesMetrics({ data, columns, onSelect }: {
  data: OverviewData;
  columns: number;
  onSelect: (section: OverviewSection, title: string) => void;
}) {
  const k = data.kpis;
  const cards: { id: OverviewSection | 'pending_quote_value'; section: OverviewSection; label: string; value: string; exact?: string; note: string; risk?: boolean }[] = [
    { id: 'pending_quote_value', section: 'pending_quotations', label: 'Pending quotation value',
      value: shortAmount(k.pending_quotations.value), exact: amount(k.pending_quotations.value),
      note: identityText(count(k.pending_quotations.document_count, 'quotation'), subtotal(k.pending_quotations)) },
    { id: 'placed', section: 'placed', label: 'Placed order value',
      value: shortAmount(k.placed_orders.value), exact: amount(k.placed_orders.value),
      note: identityText(count(k.placed_orders.document_count, 'order'), subtotal(k.placed_orders)) },
    { id: 'draft', section: 'draft', label: 'Draft customers', value: String(k.draft_customers), note: 'Distinct customers' },
    { id: 'pending', section: 'pending', label: 'Pending customers', value: String(k.pending_customers), note: 'Sent quotations' },
    { id: 'followups', section: 'followups', label: 'Follow-ups',
      value: `${k.followups.overdue} overdue`, note: `${k.followups.today} due today · ${count(k.followups.customer_count, 'customer')}`,
      risk: k.followups.overdue > 0 },
    { id: 'outstanding', section: 'outstanding', label: 'Outstanding payments',
      value: shortAmount(k.outstanding.value), exact: amount(k.outstanding.value),
      note: identityText(count(k.outstanding.customer_count, 'customer'), k.outstanding.missing_amounts ? 'Recorded balances only' : null) },
    { id: 'delivered_unpaid', section: 'delivered_unpaid', label: 'Delivered but unpaid',
      value: shortAmount(k.delivered_unpaid.value), exact: amount(k.delivered_unpaid.value),
      note: identityText(count(k.delivered_unpaid.order_count, 'order'), k.delivered_unpaid.missing_amounts ? 'Recorded balances only' : null) },
    { id: 'conversion', section: 'conversion', label: 'Quotation conversion', value: pct(k.conversion.rate),
      note: `${k.conversion.converted} of ${count(k.conversion.opportunities, 'opportunity', 'opportunities')}` },
  ];
  return <View style={styles.overview}>
    <Text accessibilityRole="header" aria-level={2} style={styles.heading}>Sales overview</Text>
    <Txt v="caption" tone="mid">Sales use the selected period. Follow-ups are current, and balances reflect recorded collections.</Txt>
    <View style={styles.grid}>
      {cards.map(card => <Metric key={card.id} id={card.id} label={card.label} value={card.value}
        note={card.note} exact={card.exact} risk={card.risk}
        style={columns === 4 ? styles.four : columns === 2 ? styles.two : styles.one}
        onPress={() => onSelect(card.section, card.label)} />)}
    </View>
  </View>;
}

function Metric({ id, label, value, exact, note, risk, style, onPress }: {
  id: string; label: string; value: string; exact?: string; note: string; risk?: boolean;
  style: { flexBasis: DimensionValue }; onPress: () => void;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={identityText(label, exact || value, note)}
    testID={`sanitary-kpi-${id}`} onPress={onPress}
    style={({ pressed, hovered }) => [styles.metric, style, webCursor,
      (pressed || hovered) && styles.hover]}>
    <View style={styles.rankHeading}>
      <Txt v="sub" tone="mid" style={styles.shrink}>{label}</Txt>
      <Feather name="chevron-right" size={16} color={color.action} accessible={false} aria-hidden />
    </View>
    <Text style={[styles.figures, risk && { color: color.risk }]}>{value}</Text>
    <Txt v="caption" tone="mid">{note}</Txt>
  </Pressable>;
}

function RankedRow({ name, value, onPress, testID, children }: {
  name: string; value: string; onPress: () => void; testID: string; children: ReactNode;
}) {
  return <Pressable accessibilityRole="button" onPress={onPress} testID={testID}
    style={({ hovered, pressed }) => [styles.rank, webCursor, (hovered || pressed) && styles.hover]}>
    <View style={styles.rankHeading}>
      <Txt v="rowTitle" style={styles.shrink}>{name}</Txt>
      <View style={styles.rankValue}>
        <Txt v="money" style={styles.shrink}>{value}</Txt>
        <Feather name="chevron-right" size={16} color={color.action} accessible={false} aria-hidden />
      </View>
    </View>
    {children}
  </Pressable>;
}

function Panel({ title, subtitle, action, paired, children }: {
  title: string; subtitle?: string; action?: ReactNode; paired?: boolean; children: ReactNode;
}) {
  return <View style={[styles.panel, paired && styles.panelPair]}>
    <View style={styles.panelHeading}>
      <View style={styles.panelTitle}>
        <Text accessibilityRole="header" aria-level={2} style={styles.heading}>{title}</Text>
        {subtitle ? <Txt v="sub">{subtitle}</Txt> : null}
      </View>
      {action}
    </View>
    {children}
  </View>;
}

const styles = StyleSheet.create({
  overview: { gap: space.x3, minWidth: 0 },
  columns: { gap: space.x3, minWidth: 0 },
  columnsWide: { flexDirection: 'row', alignItems: 'flex-start' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2 },
  one: { flexBasis: '100%' },
  two: { flexBasis: '47%', flexGrow: 1 },
  four: { flexBasis: '23%', flexGrow: 1 },
  pipelineWide: { flexBasis: '15%', flexGrow: 1 },
  pipelineNarrow: { flexBasis: 120, flexGrow: 1 },
  panel: { gap: space.x3, minWidth: 0, padding: space.x4, backgroundColor: color.surface,
    borderRadius: radius.lg, borderWidth: 1, borderColor: color.line },
  panelPair: { flex: 1 },
  panelHeading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', gap: space.x3 },
  panelTitle: { flexGrow: 1, flexBasis: 160, minWidth: 0, gap: space.x1 },
  heading: { color: color.ink, fontFamily: font.semibold, fontWeight: '600', fontSize: 18, lineHeight: 24 },
  figures: { color: color.ink, fontFamily: font.semibold, fontWeight: '600', fontSize: 22, lineHeight: 28,
    fontVariant: ['tabular-nums'] },
  metric: { minWidth: 0, minHeight: layout.tap, gap: space.x1, padding: space.x3, backgroundColor: color.surface,
    borderRadius: radius.md, borderWidth: 1, borderColor: color.line },
  hover: { backgroundColor: color.accentTint },
  rank: { gap: space.x1, paddingVertical: space.x2, paddingHorizontal: space.x2, minHeight: layout.tap,
    borderBottomColor: color.line, borderBottomWidth: 1, borderRadius: radius.sm },
  rankHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: space.x2 },
  shrink: { flexShrink: 1, minWidth: 0 },
  rankValue: { flexDirection: 'row', alignItems: 'center', gap: space.x1, flexShrink: 1, minWidth: 0 },
  track: { width: '100%', height: 4, borderRadius: radius.sm, backgroundColor: color.sunken },
  bar: { height: 4, backgroundColor: color.action, borderRadius: radius.sm },
  aging: { flexGrow: 1, flexBasis: 120, minWidth: 0, gap: space.x1,
    borderRadius: radius.sm, backgroundColor: color.canvas, padding: space.x2 },
  product: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: space.x2,
    borderBottomColor: color.line, borderBottomWidth: 1, paddingBottom: space.x2 },
  productName: { flex: 1, minWidth: 96 },
  productAmount: { flexShrink: 1, minWidth: 0 },
  image: { width: space.x10, height: space.x10 },
});
