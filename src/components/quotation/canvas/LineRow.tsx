// Line row — image · name/sku · finish · qty/rate/disc · actions · total.
// Tapping the row focuses it in the Assistant pane (right pane / mobile sheet).
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { memo, useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { ProductImage } from "@/src/components/ProductImage";
import { Badge } from "@/src/components/ui";
import { colors, font, money, PRODUCT_IMAGE_ASPECT_RATIO, radius, type } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { useBuilder } from "../context/BuilderContext";
import { computeLineBreakdown, effectivePct, sourceBadge } from "../helpers/pricing";
import { FinishSwatch } from "../shared/VariantChip";
import { grabCursor } from "../shared/grabCursor";
import type { Line, RoomDiscount } from "../helpers/types";

function LineRowImpl({
  line, drag, isActive, catDiscs, projDisc, roomDiscs, compact = false,
}: {
  line: Line;
  drag: () => void;
  isActive: boolean;
  catDiscs: Record<string, number>;
  projDisc: number;
  roomDiscs?: Record<string, RoomDiscount>;
  /** Matches BuilderShell's container-driven compact layout. */
  compact?: boolean;
}) {
  const b = useBuilder();
  const isPhone = compact;
  const [menuOpen, setMenuOpen] = useState(false);
  const l = line;
  // Native number inputs emit an empty string while a salesperson replaces a
  // value. Do not turn that transient state into a persisted zero: it makes a
  // normal edit look like the line has vanished and can autosave bad totals.
  const [qtyDraft, setQtyDraft] = useState(String(l.qty));
  const [rateDraft, setRateDraft] = useState(String(l.unit_price));
  useEffect(() => setQtyDraft(String(l.qty)), [l.qty]);
  useEffect(() => setRateDraft(String(l.unit_price)), [l.unit_price]);

  const commitQty = () => {
    const value = qtyDraft.trim();
    if (!value) { setQtyDraft(String(l.qty)); return; }
    const next = Number(value);
    if (!Number.isFinite(next) || next < 1) { setQtyDraft(String(l.qty)); return; }
    b.updateLine(l.id, { qty: next }, "qty");
  };
  const commitRate = () => {
    const value = rateDraft.trim();
    if (!value) { setRateDraft(String(l.unit_price)); return; }
    const next = Number(value);
    if (!Number.isFinite(next) || next < 0) { setRateDraft(String(l.unit_price)); return; }
    b.updateLine(l.id, { unit_price: next }, "rate");
  };
  const eff = effectivePct(l, roomDiscs || {}, catDiscs, projDisc);
  // Use the same all-line breakdown as the footer. A room-level flat discount
  // is allocated across eligible lines, so calculating this row from only its
  // own effective percentage makes the visible line total disagree with the
  // quotation grand total.
  const resolved = computeLineBreakdown(b.s.lines, projDisc, catDiscs, roomDiscs || {})
    .find((row) => row.line.id === l.id);
  const badge = sourceBadge(resolved?.source || eff.source);
  const total = resolved?.net ?? 0;
  const focused = b.assistantFocus?.kind === "line" && b.assistantFocus.line_id === l.id;

  const focus = () => {
    b.setAssistantFocus({ kind: "line", line_id: l.id });
    if (Platform.OS !== "web") Haptics.selectionAsync();
  };

  return (
    <Pressable
      onPress={focus}
      style={[
        styles.row,
        isPhone && styles.rowPhone,
        focused && { borderColor: ds.brassLine, backgroundColor: ds.brassTint },
        isActive && { opacity: 0.75, transform: [{ scale: 0.99 }] },
      ]}
    >
      <Pressable
        onLongPress={drag}
        delayLongPress={160}
        hitSlop={6}
        style={[styles.dragHandle, grabCursor]}
        testID={`line-drag-${l.id}`}
      >
        <Feather name="menu" size={14} color={colors.onSurfaceMuted} />
      </Pressable>
      <ProductImage source={l.image} style={[styles.thumb, isPhone ? styles.thumbPhone : {}]} fallbackLabel={l.sku} />
      <View style={styles.content}>
        <View style={styles.heading}>
          <View style={styles.nameGroup}>
            <Text style={styles.name} numberOfLines={isPhone ? 2 : 1}>{l.name}</Text>
            {l.finish ? <FinishSwatch finish={l.finish} size={10} /> : null}
            {badge ? <Badge tone={badge.tone} label={badge.label} /> : null}
          </View>
          <Text style={styles.total}>{money(total)}</Text>
        </View>
        <Text style={type.caption} numberOfLines={1}>{l.sku}</Text>
        {l.description ? <Text style={type.caption} numberOfLines={2}>{l.description}</Text> : null}
        <View style={styles.controls}>
          <View style={styles.mini}>
            <Text style={styles.miniLabel}>QTY</Text>
            <TextInput
              testID={`qty-${l.id}`}
              value={qtyDraft}
              keyboardType="number-pad"
              onChangeText={setQtyDraft}
              onBlur={commitQty}
              onSubmitEditing={commitQty}
              style={styles.miniVal}
              selectTextOnFocus
            />
          </View>
          <View style={styles.mini}>
            <Text style={styles.miniLabel}>RATE</Text>
            <TextInput
              testID={`rate-${l.id}`}
              value={rateDraft}
              keyboardType="decimal-pad"
              onChangeText={setRateDraft}
              onBlur={commitRate}
              onSubmitEditing={commitRate}
              style={styles.miniVal}
              selectTextOnFocus
            />
          </View>
          <Pressable
            testID={`disc-${l.id}`}
            onPress={() => b.setDiscountSheet({ kind: "line", line_id: l.id })}
            style={[styles.mini, { justifyContent: "center", flexDirection: "row", alignItems: "center", gap: 4 }]}
          >
            <Text style={styles.miniLabel}>DISC</Text>
            <Text style={styles.miniVal}>{eff.pct}%</Text>
            {l.discount_pct == null && eff.source !== "none" ? <Feather name="link" size={9} color={colors.onSurfaceMuted} /> : null}
          </Pressable>

          {isPhone ? (
            <Pressable
              testID={`line-actions-${l.id}`}
              accessibilityLabel="Line item actions"
              onPress={() => setMenuOpen((open) => !open)}
              style={styles.icon}
            >
              <Feather name="more-horizontal" size={18} color={colors.onSurfaceMuted} />
            </Pressable>
          ) : <LineActions line={l} />}
        </View>
        {isPhone && menuOpen ? <View style={styles.mobileActions}><LineActions line={l} /></View> : null}
      </View>
    </Pressable>
  );
}

function LineActions({ line }: { line: Line }) {
  const b = useBuilder();
  return (
    <>
      <Pressable testID={`line-desc-${line.id}`} accessibilityLabel="Edit description" onPress={() => b.setDescSheet({ line_id: line.id })} style={styles.icon}>
        <Feather name="align-left" size={16} color={colors.onSurfaceMuted} />
      </Pressable>
      <Pressable testID={`line-swap-${line.id}`} accessibilityLabel="Swap product" onPress={() => b.openSwap(line)} style={styles.icon}>
        <Feather name="refresh-cw" size={16} color={colors.onSurfaceMuted} />
      </Pressable>
      <Pressable testID={`line-dup-${line.id}`} accessibilityLabel="Duplicate item" onPress={() => b.duplicateLine(line.id)} style={styles.icon}>
        <Feather name="copy" size={16} color={colors.onSurfaceMuted} />
      </Pressable>
      <Pressable testID={`line-move-${line.id}`} accessibilityLabel="Move to next room" onPress={() => b.moveLineToNextRoom(line.id)} style={styles.icon}>
        <Feather name="corner-up-right" size={16} color={colors.onSurfaceMuted} />
      </Pressable>
      <Pressable testID={`line-del-${line.id}`} accessibilityLabel="Delete item" onPress={() => b.removeLine(line.id)} style={styles.icon}>
        <Feather name="trash-2" size={16} color={colors.error} />
      </Pressable>
    </>
  );
}

export const LineRow = memo(LineRowImpl);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row", gap: 10, padding: 10, borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  rowPhone: { padding: 12, gap: 8, alignItems: "flex-start" },
  dragHandle: {
    width: 20, alignItems: "center", justifyContent: "center", alignSelf: "stretch",
    marginRight: -2, marginLeft: -4,
  },
  thumb: { width: 64, aspectRatio: PRODUCT_IMAGE_ASPECT_RATIO, borderRadius: 8, backgroundColor: colors.surfaceTertiary },
  thumbPhone: { width: 88 },
  content: { flex: 1, minWidth: 0, gap: 4 },
  heading: { flexDirection: "row", alignItems: "flex-start", gap: 8 },
  nameGroup: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6 },
  name: { fontSize: 13, fontFamily: font.semibold, fontWeight: "600", color: colors.onSurface, flex: 1, letterSpacing: -0.1 },
  mini: {
    borderRadius: 7, paddingHorizontal: 8, paddingVertical: 4, minWidth: 60, minHeight: 44,
    backgroundColor: colors.surfaceTertiary,
  },
  miniLabel: { fontSize: 9, fontFamily: font.semibold, color: colors.onSurfaceMuted, fontWeight: "600", letterSpacing: 0.8 },
  miniVal: { fontSize: 13, fontFamily: font.medium, fontWeight: "500", color: colors.onSurface, padding: 0, minWidth: 40, fontVariant: ["tabular-nums"] },
  controls: { flexDirection: "row", gap: 6, marginTop: 2, flexWrap: "wrap" },
  icon: { width: 44, height: 44, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary },
  mobileActions: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 2 },
  total: { fontFamily: font.semibold, fontSize: 13, fontWeight: "600", color: colors.onSurface, fontVariant: ["tabular-nums"], letterSpacing: -0.1 },
});
