import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import {
  sanitarySalesApi, type OverviewFilters, type OverviewSection, type SanitaryActions, type SanitaryActivity,
} from '@/src/api/sanitarySales';
import { useAnalyticsRead } from '@/src/components/salesAnalytics/useAnalytics';
import { Button, Sheet, Txt } from '@/src/design/components';
import { color, space } from '@/src/design/tokens';
import { EmptyNotice, LoadNotice, Pager } from './LedgerUI';
import { amount, count, day, identityText, statusLabel } from './reportPresentation';

export type RecordSelection = {
  section: OverviewSection;
  title: string;
  groupId?: string;
};

const targetLabels = {
  quotation: 'Open quotation',
  payment: 'Open payment record',
  followup: 'Open follow-up',
};
const actionLabels: Record<string, string> = {
  overdue: 'Overdue follow-up', due_today: 'Follow-up due today', high_value_quotation: 'High-value pending quotation',
  delivered_unpaid: 'Delivered but unpaid', payment_overdue: 'Overdue payment', converted: 'Converted to order',
};

export function ActivityRow({ row, hideCustomer, onNavigate }: {
  row: SanitaryActivity;
  hideCustomer?: boolean;
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const isPayment = row.target_type === 'payment';
  const id = encodeURIComponent(row.target_id);
  const title = hideCustomer
    ? row.label || actionLabels[row.kind] || row.number || targetLabels[row.target_type]
    : row.customer_name || row.number || 'Customer unavailable';
  const meta = identityText(
    row.number && row.number !== title ? row.number : null,
    row.status ? statusLabel(row.status) : null,
    row.date && !row.due_date ? day(row.date) : null,
    row.employee,
  );
  const dueDate = row.payment_due_date || row.due_date;
  const due = dueDate ? `Due ${day(dueDate)}` : null;
  const age = row.days_overdue && row.days_overdue > 0 ? count(row.days_overdue, 'day') + ' overdue'
    : !due && row.age_days != null && row.age_reference ? `${count(row.age_days, 'day')} since ${row.age_reference}` : null;
  const open = () => {
    const path = row.target_type === 'quotation' ? `/quotations/${id}`
      : row.target_type === 'payment' ? `/payments?id=${id}`
        : `/followups?id=${id}`;
    onNavigate?.();
    router.push(`/(admin)${path}` as never);
  };
  return <View style={styles.activity} testID={`sanitary-activity-${row.id}`}>
    <View style={styles.info}>
      <Txt v="rowTitle">{title}</Txt>
      {meta ? <Txt v="sub">{meta}</Txt> : null}
      {row.reason ? <Txt v="sub">{row.reason}</Txt> : null}
      {isPayment ? <>
        <Txt v="sub">Order {amount(row.order_amount)} · Paid {amount(row.paid)}
          {row.credits ? ` · Credits ${amount(row.credits)}` : ''}</Txt>
        <Txt v="money">{amount(row.outstanding)} outstanding</Txt>
        <Txt v="caption" tone="mid">{identityText(due || 'Payment due date unrecorded', age,
          row.delivery_status === 'delivered' ? 'Delivered'
            : row.delivery_status && row.delivery_status !== 'unknown' ? `Delivery ${statusLabel(row.delivery_status).toLowerCase()}` : 'Delivery status unrecorded',
          row.delivered_at ? day(row.delivered_at) : null)}</Txt>
      </> : <>
        {row.value != null ? <Txt v="money">{amount(row.value)}</Txt> : null}
        {due || age ? <Txt v="caption" tone="mid">{identityText(due, age)}</Txt> : null}
      </>}
    </View>
    {row.target_id ? <Button label={targetLabels[row.target_type]} variant="secondary" size="sm" onPress={open} /> : null}
  </View>;
}

export function CustomerActivity({ customer, onNavigate }: { customer: SanitaryActions; onNavigate?: () => void }) {
  return <View style={styles.customer}>
    <View accessibilityRole="header" aria-level={3}><Txt v="rowTitle">{customer.customer_name}</Txt></View>
    {customer.items.map(row => <ActivityRow key={row.id} row={row} hideCustomer onNavigate={onNavigate} />)}
  </View>;
}

export function OverviewRecords({ selection, filters, onClose }: {
  selection: RecordSelection; filters: OverviewFilters; onClose: () => void;
}) {
  const [page, setPage] = useState(1);
  const key = sanitarySalesApi.overviewSectionKey(selection.section, filters, page, selection.groupId);
  const read = useAnalyticsRead(key, signal => sanitarySalesApi.overviewSection(key, signal));
  return <Sheet open onClose={onClose} title={selection.title} width={760} testID="sanitary-overview-records">
    <LoadNotice section="supporting records" loading={read.loading && !read.data} error={read.error} retry={read.refresh} />
    {read.data ? <>
      <Pager page={read.data.page} size={read.data.page_size} total={read.data.total}
        loading={read.loading} onPage={setPage} />
      {!read.data.items.length ? <EmptyNotice>No records match these filters.</EmptyNotice> : null}
      {read.data.items.map(row =>
        'items' in row
          ? <CustomerActivity key={row.id} customer={row} onNavigate={onClose} />
          : <ActivityRow key={row.id} row={row} onNavigate={onClose} />)}
    </> : null}
  </Sheet>;
}

const styles = StyleSheet.create({
  activity: {
    borderBottomWidth: 1, borderBottomColor: color.line, paddingVertical: space.x2,
    gap: space.x2, flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', justifyContent: 'space-between',
  },
  info: { minWidth: 0, flexGrow: 1, flexBasis: 180, gap: space.x1 },
  customer: { gap: space.x1, paddingTop: space.x2 },
});
