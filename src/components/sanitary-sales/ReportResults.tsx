import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { sanitarySalesApi, type SanitaryFilters, type SanitaryMetrics, type SanitaryReadFilters, type SanitaryReport, type SanitarySummary } from '@/src/api/sanitarySales';
import { ProductImage } from '@/src/components/ProductImage';
import { useAnalyticsRead } from '@/src/components/salesAnalytics/useAnalytics';
import { Txt } from '@/src/design/components';
import { color, radius, space } from '@/src/design/tokens';
import { EmptyNotice, LedgerRow, LoadNotice, Pager, RecordedAmount } from './LedgerUI';
import { ReportDocuments } from './ReportDocuments';
import { amount, basisLabels, count, day, documentNoun, identityText, quantity, statusLabel } from './reportPresentation';

const PAGE_SIZE = 15;
type Scope = Pick<SanitaryReadFilters, 'group_id' | 'customer_id'>;

export function ReportResults({ report, filters, onTotals, scope }: {
  report: SanitaryReport;
  filters: SanitaryFilters;
  onTotals?: (totals: SanitaryMetrics | null) => void;
  scope?: Scope;
}) {
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string>();
  const params = { ...filters, ...scope, page, page_size: PAGE_SIZE };
  const key = sanitarySalesApi.reportKey(report, params);
  const read = useAnalyticsRead(key, signal => sanitarySalesApi.report(report, params, signal));
  const data = read.data;
  const totals = data?.totals;

  useEffect(() => {
    if (totals) onTotals?.(totals);
    else if (read.error) onTotals?.(null);
  }, [onTotals, read.error, totals]);

  const noun = documentNoun(report);
  const isProductReport = report === 'products';
  const isProductRanking = isProductReport && !scope;
  const type = scope?.customer_id ? `${noun}s` : scope ? 'details' : 'report';
  const empty = isProductRanking ? 'No products match these filters.'
    : noun === 'quotation' ? 'No pending quotations match these filters.' : 'No placed orders match these filters.';
  const amountLabel = isProductRanking ? 'Sales value' : noun === 'quotation' ? 'Quotation value' : 'Order value';
  return <View style={styles.results}>
    <LoadNotice loading={read.loading && !data} error={read.error} retry={read.refresh} section={type} />
    {data && <>
      {read.refreshing && <Txt v="caption" tone="mid">Updating {type}…</Txt>}
      {!scope && <View style={styles.totals}>
        <RecordedAmount label={`${amountLabel} · ${basisLabels[filters.value_basis]}`}
          value={data.totals.value} missing={data.totals.missing_value_lines} />
        <View style={styles.counts}>
          <Txt v="sub">{count(data.totals.document_count, noun)} · {count(data.totals.customer_count, 'customer')}</Txt>
          {data.date_from && data.date_to && <Txt v="caption" tone="soft">{day(data.date_from)} – {day(data.date_to)}</Txt>}
        </View>
      </View>}
      {!scope && data.notes.map(note => <Txt key={note} v="sub">{note}</Txt>)}
      <Pager page={data.page} size={data.page_size} total={data.total} loading={read.loading}
        onPage={next => { setExpanded(undefined); setPage(next); }} />
      {!data.items.length ? <EmptyNotice>{empty}</EmptyNotice> :
        data.level === 'documents' ? <ReportDocuments key={key} rows={data.items} report={report} basis={filters.value_basis} />
          : <View>{data.items.map((row, index) => {
            const open = expanded === row.id;
            const nextScope = data.level === 'customers'
              ? { group_id: scope?.group_id, customer_id: row.id }
              : { group_id: row.id };
            return <View key={row.id} style={index ? styles.rule : undefined}>
              <SummaryRow row={row} isProduct={isProductRanking} noun={noun}
                rankQuantity={filters.sort === 'quantity'} showCustomers={data.level === 'groups' && report.includes('interior')}
                open={open} onToggle={() => setExpanded(open ? undefined : row.id)} />
              {open && <View style={styles.nested}>
                <ReportResults report={report} filters={filters} scope={nextScope} />
              </View>}
            </View>;
          })}</View>}
      {data.page > 1 && !data.items.length && <Txt v="sub">Choose the previous page to see current results.</Txt>}
    </>}
  </View>;
}

function SummaryRow({ row, open, onToggle, isProduct, rankQuantity, showCustomers, noun }: {
  row: SanitarySummary; open: boolean; onToggle: () => void; isProduct: boolean; rankQuantity: boolean;
  showCustomers: boolean; noun: 'quotation' | 'order';
}) {
  const byQuantity = isProduct && rankQuantity;
  const soldQuantity = isProduct ? quantity(row.quantity, row.unit) : null;
  const productMetadata = identityText(row.brand, row.sku ? `Article ${row.sku}` : null, row.size, row.finish);
  const statuses = row.statuses.map(statusLabel).join(', ');
  const peopleMetadata = identityText(
    showCustomers ? count(row.customer_count, 'customer') : null,
    count(row.document_count, noun),
    row.brands.join(', '),
    statuses,
  );
  const detail = isProduct ? identityText(
    !byQuantity ? soldQuantity : null,
    `MRP ${amount(row.mrp_value)}${row.mrp_value != null && row.missing_mrp_lines > 0 ? ' subtotal' : ''}`,
    `Offer Price ${amount(row.offer_value)}${row.offer_value != null && row.missing_offer_lines > 0 ? ' subtotal' : ''}`,
  ) : undefined;
  return <LedgerRow testID={`sanitary-row-${row.id}`} title={row.name} open={open} onPress={onToggle}
    subtitle={isProduct ? productMetadata : peopleMetadata} detail={detail}
    displayValue={byQuantity ? soldQuantity ?? undefined : amount(row.value)}
    valueNote={!byQuantity && row.value != null && row.missing_value_lines > 0 ? 'Recorded subtotal' : undefined}
    thumbnail={isProduct && row.image_url ? <ProductImage source={row.image_url}
      accessibilityLabel={`${row.name} product photo`} style={styles.image} borderRadius={radius.sm} disableSkeleton /> : undefined} />;
}

const styles = StyleSheet.create({
  results: { gap: space.x3, minWidth: 0 },
  totals: {
    flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-start', justifyContent: 'space-between', gap: space.x3,
    backgroundColor: color.canvas, borderRadius: radius.md, padding: space.x3,
  },
  counts: { gap: space.x1, minWidth: 0, flexShrink: 1 },
  nested: { borderLeftColor: color.lineStrong, borderLeftWidth: 1, paddingLeft: space.x2, paddingVertical: space.x2 },
  rule: { borderTopWidth: 1, borderTopColor: color.line },
  image: { width: space.x10, height: space.x10 },
});
