// Line row — image · name/sku · finish · qty/rate/disc · actions · total.
// Tapping the row focuses it in the Assistant pane (right pane / mobile sheet).
import Feather from "@expo/vector-icons/Feather";
import * as Haptics from "expo-haptics";
import { memo, useEffect, useState } from "react";
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { ProductImage } from "@/src/components/ProductImage";
import { Badge } from "@/src/components/ui";
import { ConfirmDialog } from "@/src/components/ds";
import { colors, font, money, radius, type } from "@/src/theme/tokens";
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
  const [actionsOpen, setActionsOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [hovered, setHovered] = useState(false);
  const l = line;
  const isIncluded = !!l.included_for_line_id;
  // Native number inputs emit an empty string while a salesperson replaces a
  // value. Do not turn that transient state into a persisted zero: it makes a
  // normal edit look like the line has vanished and can autosave bad totals.
  const [qtyDraft, setQtyDraft] = useState(String(l.qty));
  const [rateDraft, setRateDraft] = useState(String(l.unit_price));
  const [areaDraft, setAreaDraft] = useState(l.area || "");
  useEffect(() => setQtyDraft(String(l.qty)), [l.qty]);
  useEffect(() => setRateDraft(String(l.unit_price)), [l.unit_price]);
  useEffect(() => setAreaDraft(l.area || ""), [l.area]);

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
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={[
        styles.row,
        isPhone && styles.rowPhone,
        hovered && !isActive && !focused && styles.rowHovered,
        focused && { borderColor: ds.brassLine, backgroundColor: ds.brassTint },
        // Dragging should read as an in-progress reordering state, not a
        // generic card-press animation. Color and opacity preserve the row's
        // geometry so adjacent controls never appear to jump.
        isActive && { opacity: 0.75, borderColor: colors.brandBorder, backgroundColor: colors.brandTint },
      ]}
    >
      <Pressable
        onLongPress={isIncluded ? undefined : drag}
        delayLongPress={160}
        hitSlop={6}
        style={[styles.dragHandle, grabCursor]}
        testID={`line-drag-${l.id}`}
      >
        <Feather name="menu" size={14} color={colors.onSurfaceMuted} />
      </Pressable>
      <ProductImage
        source={l.image}
        style={isPhone ? [styles.thumb, styles.thumbPhone] : styles.thumb}
        fallbackLabel={l.sku}
        frameInset={5}
        transition={120}
      />
      <View style={styles.content}>
        <View style={styles.heading}>
          <View style={styles.nameGroup}>
            <Text style={styles.name} numberOfLines={isPhone ? 2 : 1}>{l.name}</Text>
            {isIncluded ? <Badge tone="success" label="Included" /> : null}
            {l.finish ? <FinishSwatch finish={l.finish} size={10} /> : null}
            {badge ? <Badge tone={badge.tone} label={badge.label} /> : null}
          </View>
          <Text style={styles.total} numberOfLines={1}>{money(total)}</Text>
        </View>
        <Text style={type.caption} numberOfLines={1}>{l.sku}</Text>
        <View style={styles.areaRow}>
          <Feather name="layers" size={13} color={colors.onSurfaceMuted} />
          <TextInput
            testID={`line-area-${l.id}`}
            accessibilityLabel={`Presentation area for ${l.name}`}
            value={areaDraft}
            onChangeText={setAreaDraft}
            onBlur={() => b.updateLine(l.id, { area: areaDraft.trim() || null }, "area")}
            onSubmitEditing={() => b.updateLine(l.id, { area: areaDraft.trim() || null }, "area")}
            placeholder="Area for PPT, e.g. Basin Area"
            placeholderTextColor={colors.onSurfaceMuted}
            returnKeyType="done"
            style={styles.areaInput}
          />
        </View>
        <View style={styles.areaRow}>
          <Feather name="image" size={13} color={colors.onSurfaceMuted} />
          <Text style={type.caption}>Dimension diagram in PDF</Text>
          <Pressable
            testID={`line-exclude-dimension-${l.id}`}
            accessibilityRole="checkbox"
            accessibilityLabel={`Exclude dimension diagram from PDF for ${l.name}`}
            accessibilityState={{ checked: !!l.exclude_dimension }}
            onPress={() => b.updateLine(l.id, { exclude_dimension: !l.exclude_dimension })}
          >
            <Feather name={l.exclude_dimension ? "check-square" : "square"} size={15} color={colors.onSurfaceMuted} />
          </Pressable>
        </View>
        {l.description ? <Text style={type.caption} numberOfLines={2}>{l.description}</Text> : null}
        <View style={styles.controls}>
          {isIncluded ? (
            <Text style={styles.includedHint}>Quantity follows its selected product</Text>
          ) : <>
            <View style={styles.mini}>
              <Text style={styles.miniLabel}>QTY</Text>
              <TextInput testID={`qty-${l.id}`} value={qtyDraft} keyboardType="number-pad" onChangeText={setQtyDraft} onBlur={commitQty} onSubmitEditing={commitQty} style={styles.miniVal} selectTextOnFocus />
            </View>
            <View style={styles.mini}>
              <Text style={styles.miniLabel}>RATE</Text>
              <TextInput testID={`rate-${l.id}`} value={rateDraft} keyboardType="decimal-pad" onChangeText={setRateDraft} onBlur={commitRate} onSubmitEditing={commitRate} style={styles.miniVal} selectTextOnFocus />
            </View>
            <Pressable testID={`disc-${l.id}`} onPress={() => b.setDiscountSheet({ kind: "line", line_id: l.id })} style={[styles.mini, { justifyContent: "center", flexDirection: "row", alignItems: "center", gap: 4 }]}>
              <Text style={styles.miniLabel}>DISC</Text>
              <Text style={styles.miniVal}>{eff.pct}%</Text>
              {l.discount_pct == null && eff.source !== "none" ? <Feather name="link" size={9} color={colors.onSurfaceMuted} /> : null}
            </Pressable>
            <Pressable testID={`line-actions-${l.id}`} accessibilityLabel={actionsOpen ? "Hide product actions" : "Show product actions"} accessibilityState={{ expanded: actionsOpen }} onPress={() => setActionsOpen((open) => !open)} style={({ pressed }) => [styles.icon, actionsOpen && styles.iconSelected, pressed && styles.iconPressed]}>
              <Feather name={actionsOpen ? "chevron-up" : "more-horizontal"} size={18} color={actionsOpen ? ds.brassDeep : colors.onSurfaceMuted} />
            </Pressable>
            <RemoveLineButton line={l} onCancel={() => setCancelOpen(true)} />
          </>}
        </View>
        {actionsOpen && !isIncluded ? <View style={styles.secondaryActions}><LineActions line={l} /></View> : null}
      </View>
      <ConfirmDialog
        visible={cancelOpen}
        onClose={() => { if (!cancelling) setCancelOpen(false); }}
        onConfirm={async () => {
          setCancelling(true);
          const cancelled = await b.cancelLine(l.id);
          setCancelling(false);
          if (cancelled) setCancelOpen(false);
        }}
        title="Cancel this product?"
        description="This removes it from the quotation and cancels any unfulfilled purchase line. Fulfilled items or completed-payment adjustments will stay unchanged and explain the next step."
        confirmLabel="Cancel product"
        tone="danger"
        loading={cancelling}
        testID={`confirm-cancel-line-${l.id}`}
      />
    </Pressable>
  );
}

function RemoveLineButton({ line, onCancel }: { line: Line; onCancel: () => void }) {
  const b = useBuilder();
  const saved = !!b.quotationId;
  return (
    <Pressable
      testID={saved ? `line-cancel-${line.id}` : `line-del-${line.id}`}
      accessibilityLabel={saved ? "Cancel product" : "Remove product"}
      onPress={saved ? onCancel : () => b.removeLine(line.id)}
      style={({ pressed }) => [styles.icon, styles.removeIcon, pressed && styles.removeIconPressed]}
    >
      <Feather name={saved ? "x-circle" : "trash-2"} size={17} color={colors.error} />
    </Pressable>
  );
}

function LineActions({ line }: { line: Line }) {
  const b = useBuilder();
  return (
    <>
      <Pressable testID={`line-move-up-${line.id}`} accessibilityLabel="Move product up" onPress={() => b.moveLine(line.id, -1)} style={styles.icon}>
        <Feather name="chevron-up" size={16} color={colors.onSurfaceMuted} />
      </Pressable>
      <Pressable testID={`line-move-down-${line.id}`} accessibilityLabel="Move product down" onPress={() => b.moveLine(line.id, 1)} style={styles.icon}>
        <Feather name="chevron-down" size={16} color={colors.onSurfaceMuted} />
      </Pressable>
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
    </>
  );
}

export const LineRow = memo(LineRowImpl);

const styles = StyleSheet.create({
  row: {
    flexDirection: "row", gap: 10, padding: 10, borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  rowHovered: { borderColor: colors.brandBorder, backgroundColor: colors.surface, transform: [{ translateY: -1 }] },
  rowPhone: { padding: 12, gap: 8, alignItems: "flex-start" },
  dragHandle: {
    width: 20, alignItems: "center", justifyContent: "center", alignSelf: "stretch",
    marginRight: -2, marginLeft: -4,
  },
  // A compact portrait frame gives product imagery enough vertical room in
  // the narrow quotation panel. `contain` in ProductImage preserves every
  // supplier image without cropping it into a misleading landscape strip.
  thumb: { width: 56, height: 68, borderRadius: 9, backgroundColor: colors.surfaceTertiary },
  thumbPhone: { width: 64, height: 76 },
  content: { flex: 1, minWidth: 0, gap: 4 },
  areaRow: { flexDirection: "row", alignItems: "center", gap: 6, minHeight: 36, marginTop: 2 },
  areaInput: { flex: 1, minWidth: 0, paddingVertical: 5, paddingHorizontal: 8, borderRadius: 7, backgroundColor: colors.surfaceTertiary, color: colors.onSurface, fontSize: 12 },
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
  includedHint: { alignSelf: "center", fontSize: 11, color: colors.onSurfaceMuted, fontStyle: "italic" },
  icon: { width: 40, height: 40, borderRadius: 9, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary },
  iconSelected: { backgroundColor: ds.brassTint, borderWidth: StyleSheet.hairlineWidth, borderColor: ds.brassLine },
  iconPressed: { opacity: 0.72, transform: [{ scale: 0.96 }] },
  removeIcon: { backgroundColor: colors.surface, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  removeIconPressed: { opacity: 0.72, transform: [{ scale: 0.96 }], backgroundColor: "#FDECEC" },
  secondaryActions: { flexDirection: "row", flexWrap: "wrap", gap: 6, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  total: { fontFamily: font.semibold, fontSize: 13, fontWeight: "600", color: colors.onSurface, fontVariant: ["tabular-nums"], letterSpacing: -0.1, flexShrink: 0 },
});
