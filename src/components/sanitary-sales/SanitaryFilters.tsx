import Feather from '@expo/vector-icons/Feather';
import { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, View } from 'react-native';
import type { SanitaryFilters, SanitaryPreset, SanitaryValueBasis } from '@/src/api/sanitarySales';
import { KitchenDateField } from '@/src/components/kitchen/KitchenFilters';
import { Text } from '@/src/components/AppText';
import { isAnalyticsCalendarDate, validAnalyticsRange } from '@/src/components/salesAnalytics/dateBounds';
import { Button, Sheet, Txt } from '@/src/design/components';
import { webCursor } from '@/src/design/shared';
import { color, font, layout, radius, space } from '@/src/design/tokens';
import { basisLabels, day } from './reportPresentation';

type Option<T extends string> = { id: T; name: string };

export const periods: Option<SanitaryPreset>[] = [
  { id: 'last_7_days', name: 'Last 7 days' },
  { id: 'last_30_days', name: 'Last 30 days' },
  { id: 'custom', name: 'Custom range' },
  { id: 'all_time', name: 'All time' },
];

export function FilterOptions<T extends string>({ options, selected, onSelect, testID }: {
  options: readonly Option<T>[];
  selected: T;
  onSelect: (id: T) => void;
  testID: string;
}) {
  return <View style={{ gap: space.x2 }}>{options.map(option => {
    const active = selected === option.id;
    return <Pressable key={option.id} testID={`${testID}-${option.id}`} onPress={() => onSelect(option.id)}
      accessibilityRole="button" accessibilityState={{ selected: active }} aria-pressed={active}
      style={({ pressed, hovered }) => [styles.option, webCursor,
        { backgroundColor: active ? color.accentTint : pressed || hovered ? color.sunken : color.canvas }]}>
      <Txt style={{ flex: 1 }}>{option.name}</Txt>
      {active && <Feather name="check" size={16} color={color.action} accessible={false} aria-hidden />}
    </Pressable>;
  })}</View>;
}

function FilterTrigger({ label, value, open, onPress, testID, trigger }: {
  label: string; value: string; open: boolean; onPress: () => void; testID: string;
  trigger: React.RefObject<View | null>;
}) {
  return <View style={{ minWidth: 0, maxWidth: '100%', gap: space.x1 }}>
    <Txt v="caption" tone="mid">{label}</Txt>
    <Pressable ref={trigger} accessibilityRole="button" accessibilityLabel={`${label}, ${value}`}
      accessibilityState={{ expanded: open }} aria-expanded={open} onPress={onPress} testID={testID}
      style={({ hovered, pressed }) => [styles.trigger, webCursor,
        { backgroundColor: hovered || pressed ? color.canvas : color.surface }]}>
      <Text style={styles.controlText}>{value}</Text>
      <Feather name="chevron-down" size={16} color={color.inkMid} accessible={false} aria-hidden />
    </Pressable>
  </View>;
}

export function ReportChoice<T extends string>({ label, value, options, onChange, testID }: {
  label: string; value: T; options: readonly Option<T>[]; onChange: (id: T) => void; testID: string;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<View>(null);
  return <>
    <FilterTrigger label={label} value={options.find(option => option.id === value)?.name || 'Select'}
      open={open} onPress={() => setOpen(true)} testID={testID} trigger={trigger} />
    <Sheet open={open} onClose={() => setOpen(false)} title={label} returnFocusRef={trigger} testID={`${testID}-sheet`}>
      <FilterOptions options={options} selected={value} onSelect={id => { onChange(id); setOpen(false); }} testID={testID} />
    </Sheet>
  </>;
}

type PeriodFilter = Pick<SanitaryFilters, 'preset' | 'date_from' | 'date_to'>;

function Dates({ value, onChange }: { value: PeriodFilter; onChange: (filter: PeriodFilter) => void }) {
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState(false);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState(false);
  const trigger = useRef<View>(null);
  const content = useRef<View>(null);
  const restoreModeFocus = useRef(false);
  useEffect(() => {
    if (!open || !restoreModeFocus.current) return;
    restoreModeFocus.current = false;
    if (Platform.OS === 'web') (content.current as unknown as HTMLElement | null)?.focus();
  }, [open, custom]);

  const changeMode = (next: boolean) => {
    restoreModeFocus.current = true;
    setCustom(next);
  };
  const selected = value.preset === 'custom' && value.date_from && value.date_to
    ? `${day(value.date_from)} – ${day(value.date_to)}`
    : periods.find(period => period.id === value.preset)?.name || 'All time';
  const show = () => {
    setCustom(value.preset === 'custom');
    setFrom(value.date_from || '');
    setTo(value.date_to || '');
    setError(false);
    setOpen(true);
  };
  const select = (preset: SanitaryPreset) => {
    if (preset === 'custom') { changeMode(true); return; }
    onChange({ preset });
    setOpen(false);
  };
  const apply = () => {
    if (!isAnalyticsCalendarDate(from) || !isAnalyticsCalendarDate(to) || !validAnalyticsRange(from, to)) {
      setError(true);
      return;
    }
    onChange({ preset: 'custom', date_from: from, date_to: to });
    setOpen(false);
  };

  return <>
    <FilterTrigger label="Date range · India" value={selected} open={open} onPress={show}
      testID="sanitary-period" trigger={trigger} />
    <Sheet open={open} onClose={() => setOpen(false)} title={custom ? 'Custom date range' : 'Date range'}
      subtitle={custom ? 'Both dates are included in India time.' : 'Pending reports use quotation date. Placed orders and both rankings use order placement date.'}
      returnFocusRef={trigger} testID="sanitary-date-sheet"
      footer={custom ? <>
        <Button label="Apply dates" testID="sanitary-apply-dates" onPress={apply} />
        <Button label="Choose a preset" variant="ghost" onPress={() => changeMode(false)} />
      </> : undefined}>
      <View ref={content} tabIndex={-1} style={{ gap: space.x3 }}>
        {custom ? <>
        <KitchenDateField label="From date" value={from} onChange={value => { setFrom(value); setError(false); }}
          defaultToToday={false} testID="sanitary-date-from" />
        <KitchenDateField label="To date" value={to} onChange={value => { setTo(value); setError(false); }}
          min={from || undefined} defaultToToday={false} testID="sanitary-date-to" />
        {error && <Text accessibilityRole="alert" style={{ color: color.risk }}>Choose a valid start and end date, with the end on or after the start.</Text>}
      </> : <FilterOptions options={periods} selected={value.preset} onSelect={select} testID="sanitary-period" />}
      </View>
    </Sheet>
  </>;
}

export function SharedSanitaryFilters({ filters, onDateChange, onBasisChange }: {
  filters: SanitaryFilters; onDateChange: (filter: PeriodFilter) => void; onBasisChange: (basis: SanitaryValueBasis) => void;
}) {
  return <View style={styles.filters}>
    <Dates value={filters} onChange={onDateChange} />
    <View style={{ gap: space.x1, minWidth: 0, maxWidth: '100%' }}>
      <Txt v="caption" tone="mid">Value basis</Txt>
      <View style={styles.basis} accessibilityLabel="Value basis">
        {(['mrp', 'offer'] as const).map(basis => {
          const active = filters.value_basis === basis;
          return <Pressable key={basis} testID={`sanitary-${basis}`} accessibilityRole="button"
            accessibilityState={{ selected: active }} aria-pressed={active} onPress={() => onBasisChange(basis)}
            style={({ pressed, hovered }) => [styles.basisButton, webCursor,
              basis === 'mrp' ? styles.basisStart : styles.basisEnd,
              { backgroundColor: active ? color.accentTint : pressed || hovered ? color.canvas : color.surface }]}>
            <Text style={[styles.controlText, active && { color: color.action, fontWeight: '600' }]}>{basisLabels[basis]}</Text>
          </Pressable>;
        })}
      </View>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  filters: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', gap: space.x3 },
  trigger: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: layout.tap,
    borderColor: color.controlBorder, borderWidth: 1, borderRadius: radius.md, gap: space.x2, padding: space.x3,
  },
  controlText: { color: color.ink, fontFamily: font.medium, fontSize: 14, fontWeight: '500', flexShrink: 1 },
  option: { minHeight: layout.tap, flexDirection: 'row', alignItems: 'center', gap: space.x2, padding: space.x3, borderRadius: radius.sm },
  basis: { flexDirection: 'row', flexWrap: 'wrap', borderColor: color.controlBorder, borderWidth: 1, borderRadius: radius.md },
  basisStart: { borderTopLeftRadius: radius.md, borderBottomLeftRadius: radius.md },
  basisEnd: { borderTopRightRadius: radius.md, borderBottomRightRadius: radius.md },
  basisButton: { minHeight: layout.tap, justifyContent: 'center', minWidth: layout.tap, paddingVertical: space.x2, paddingHorizontal: space.x3 },
});
