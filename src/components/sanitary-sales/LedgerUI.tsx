import Feather from '@expo/vector-icons/Feather';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { Text } from '@/src/components/AppText';
import { Button, Txt } from '@/src/design/components';
import { useBp } from '@/src/design/responsive';
import { webCursor } from '@/src/design/shared';
import { color, font, layout, radius, space } from '@/src/design/tokens';
import { amount } from './reportPresentation';

export function LedgerRow({ title, subtitle, detail, displayValue, valueNote, thumbnail, section, label, onPress, open, testID }: {
  title: string;
  subtitle?: string;
  detail?: string;
  displayValue?: string;
  valueNote?: string;
  thumbnail?: ReactNode;
  section?: boolean;
  label?: string;
  onPress: () => void;
  open: boolean;
  testID: string;
}) {
  const { width, fontScale } = useWindowDimensions();
  const stacked = fontScale > 1.3 || width < 360;
  const spoken = [label || title, subtitle, detail, displayValue, valueNote].filter(Boolean).join(', ');
  return <Pressable testID={testID} onPress={onPress} accessibilityRole="button" accessibilityLabel={spoken}
    accessibilityState={{ expanded: open }} aria-expanded={open} style={({ pressed, hovered }) => [
      styles.row, webCursor, section ? styles.sectionRow : styles.recordRow,
      { backgroundColor: pressed || hovered ? color.canvas : color.surface },
    ]}>
    {thumbnail}
    <View style={[styles.rowBody, stacked && styles.rowStacked]}>
      <View style={styles.identity}>
        <Text style={[styles.title, section && styles.sectionTitle]}>{title}</Text>
        {subtitle && <Txt v="sub">{subtitle}</Txt>}
        {detail && <Txt v="caption" tone="mid">{detail}</Txt>}
      </View>
      {displayValue && <View style={[styles.value, stacked && styles.valueStacked]}>
        <Text style={styles.figures}>{displayValue}</Text>
        {valueNote && <Txt v="caption" tone="soft" style={{ textAlign: 'right' }}>{valueNote}</Txt>}
      </View>}
    </View>
    <Feather name={open ? 'chevron-up' : 'chevron-down'} size={16} color={color.inkMid}
      accessible={false} aria-hidden />
  </Pressable>;
}

export function MissingSubtotal({ missing }: { missing: number }) {
  return <Txt v="caption" tone="soft">Recorded subtotal · {missing} {missing === 1 ? 'line missing' : 'lines missing'} pricing</Txt>;
}

export function RecordedAmount({ label, value, missing }: { label: string; value: number | null; missing: number }) {
  return <View style={{ gap: space.x1, flexShrink: 1, minWidth: 0 }}>
    <Txt v="caption" tone="mid">{label}</Txt>
    <Text style={styles.total}>{amount(value)}</Text>
    {value != null && missing > 0 && <MissingSubtotal missing={missing} />}
  </View>;
}

export function LoadNotice({ loading, error, retry, section }: {
  loading: boolean; error: string | null; retry: () => void; section: string;
}) {
  if (error) return <View style={styles.notice}>
    <Text accessibilityRole="alert" style={styles.message}>{error}</Text>
    <Button label={`Retry ${section}`} variant="secondary" onPress={retry} size="sm" />
  </View>;
  if (!loading) return null;
  return <View style={styles.notice}>
    <Text role="status" accessibilityLiveRegion="polite" style={styles.message}>Loading {section}…</Text>
    <View aria-hidden style={styles.placeholder}>
      <View style={[styles.skeleton, { width: '48%' }]} />
      <View style={[styles.skeleton, { width: '24%' }]} />
    </View>
  </View>;
}

export function Pager({ page, size, total, onPage, loading }: {
  page: number; size: number; total: number; onPage: (page: number) => void; loading: boolean;
}) {
  const { isPhone } = useBp();
  const from = (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  if (total <= size && page === 1) return null;
  return <View style={[styles.pager, isPhone && { justifyContent: 'flex-start' }]}>
    <Txt v="num">{total ? `${from}–${to} of ${total}` : `Page ${page}`}</Txt>
    <View style={styles.pageButtons}>
      <Button label="Previous page" size="sm" variant="secondary" disabled={loading || page <= 1}
        onPress={() => onPage(page - 1)} />
      <Button label="Next page" size="sm" variant="secondary" disabled={loading || page * size >= total}
        onPress={() => onPage(page + 1)} />
    </View>
  </View>;
}

export function EmptyNotice({ children }: { children: ReactNode }) {
  return <View style={styles.notice}>
    <Text role="status" style={styles.message}>{children}</Text>
  </View>;
}

export function InlineError({ message }: { message: string }) {
  return <Text accessibilityRole="alert" style={[styles.message, { color: color.risk }]}>{message}</Text>;
}

const styles = StyleSheet.create({
  row: {
    minHeight: layout.tap + space.x2, flexDirection: 'row', alignItems: 'center', minWidth: 0,
    gap: space.x3, paddingVertical: space.x2, borderRadius: radius.sm,
  },
  sectionRow: { paddingHorizontal: space.x4, minHeight: layout.tap + space.x3 },
  recordRow: { paddingHorizontal: space.x2 },
  rowBody: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', gap: space.x3 },
  rowStacked: { flexDirection: 'column', alignItems: 'stretch', gap: space.x1 },
  identity: { flex: 1, minWidth: 0, gap: space.x1 },
  value: { flexShrink: 1, minWidth: 0, maxWidth: '50%', alignItems: 'flex-end', gap: space.x1 },
  valueStacked: { maxWidth: '100%' },
  title: { fontFamily: font.medium, color: color.ink, fontWeight: '500', fontSize: 15, lineHeight: 21 },
  sectionTitle: { fontWeight: '600', fontSize: 16, lineHeight: 24 },
  figures: { fontFamily: font.semibold, color: color.ink, fontWeight: '600', fontVariant: ['tabular-nums'], fontSize: 15, lineHeight: 21, textAlign: 'right' },
  total: { fontFamily: font.medium, color: color.ink, fontWeight: '500', fontVariant: ['tabular-nums'], fontSize: 22, lineHeight: 28 },
  pager: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: space.x2 },
  pageButtons: { flexDirection: 'row', flexWrap: 'wrap', gap: space.x2 },
  notice: { gap: space.x2, padding: space.x3, borderRadius: radius.md, backgroundColor: color.canvas },
  message: { fontFamily: font.regular, color: color.inkMid, fontSize: 14, lineHeight: 20 },
  placeholder: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', minHeight: layout.tap },
  skeleton: { height: 16, backgroundColor: color.sunkenDeep, borderRadius: radius.sm },
});
