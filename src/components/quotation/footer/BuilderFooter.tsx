// Builder footer — notes, discount bar, totals grid, finalize CTA.
//
// Desktop/tablet: everything shown at all times (unchanged from V4).
// Phone: a single sticky compact bar (item count + grand total + Add +
// Finish) is shown by default — tapping it expands the same note/discount/
// breakdown content inline above it. This replaces what used to be TWO
// separate, redundant footers stacked on top of each other (this component's
// full desktop layout PLUS a second mobile summary) — which is what made
// the phone builder feel completely broken/cluttered.
import { useState } from "react";
import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, font, money, radius, spacing, type } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { useBuilder } from "../context/BuilderContext";

function NotesAndDiscount({ b }: { b: ReturnType<typeof useBuilder> }) {
  return (
    <>
      <View style={styles.notes}>
        <Feather name="edit-3" size={13} color={colors.onSurfaceMuted} />
        <TextInput
          accessibilityLabel="Customer note printed on quotation PDF"
          testID="quote-notes-input"
          value={b.s.notes}
          onChangeText={b.setNotes}
          placeholder="Add a note for the customer (printed on the PDF)…"
          placeholderTextColor={colors.onSurfaceMuted}
          style={styles.notesInput}
          multiline
        />
      </View>

      <Pressable
        onPress={() => b.setDiscountSheet({ kind: "project" })}
        accessibilityRole="button"
        accessibilityLabel="Edit quotation discounts"
        testID="open-discount-sheet"
        style={styles.discBar}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={type.overline}>Discount</Text>
          <Text style={{ fontSize: 12, color: colors.onSurfaceSecondary }} numberOfLines={1}>
            {b.s.projectDiscount ? `Project ${b.s.projectDiscount}%` : "No project discount"}
            {Object.keys(b.s.categoryDiscounts).length ? ` · ${Object.keys(b.s.categoryDiscounts).length} category discounts` : ""}
          </Text>
        </View>
        <Feather name="sliders" size={14} color={colors.onSurface} />
      </Pressable>

      <View style={styles.totals}>
        <Row label="Subtotal" value={money(b.totals.subtotal)} />
        <Row label="Discount" value={`− ${money(b.totals.discount)}`} valueColor={colors.error} />
      </View>
    </>
  );
}

export function BuilderFooter({ compact = false }: { compact?: boolean }) {
  const b = useBuilder();
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);

  const canFinish = !!b.s.customerId && b.s.lines.length > 0;

  if (compact) {
    return (
      <View style={styles.phoneWrap}>
        {expanded ? (
          <View style={styles.phoneExpanded}>
            <NotesAndDiscount b={b} />
          </View>
        ) : null}

        <View style={[styles.phoneBar, { paddingBottom: Math.max(spacing.md, insets.bottom + spacing.sm) }]}>
          <Pressable accessibilityRole="button" accessibilityLabel="Quotation totals, notes and discounts" accessibilityState={{ expanded }} testID="mobile-footer-toggle" onPress={() => setExpanded((v) => !v)} style={styles.phoneSummary}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Text style={type.caption} numberOfLines={1}>{b.s.lines.length} items · {b.saveLabel}</Text>
              <Feather name={expanded ? "chevron-down" : "chevron-up"} size={13} color={colors.onSurfaceMuted} />
            </View>
            <Text style={styles.phoneTotal} numberOfLines={1}>{money(b.totals.grand)}</Text>
          </Pressable>
          <View style={styles.phoneActions}>
            <Pressable accessibilityRole="button" accessibilityLabel="Add products to quotation" testID="mobile-add-first" onPress={() => b.setPickerSheetOpen(true)} style={styles.secondary}>
              <Feather name="plus" size={16} color={colors.onSurface} />
              <Text style={styles.secondaryText}>Add</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Finish and review quotation"
              accessibilityState={{ disabled: !canFinish }}
              testID="mobile-finalize"
              onPress={() => { if (canFinish) b.finalize(); }}
              disabled={!canFinish}
              style={({ pressed }) => [styles.primary, { opacity: !canFinish ? 0.4 : pressed ? 0.9 : 1 }]}
            >
              <Feather name="check" size={16} color={ds.canvas} />
              <Text style={styles.saveBtnTextSm}>Finish</Text>
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <NotesAndDiscount b={b} />
      <View style={[styles.tRow, { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, paddingTop: 8, marginTop: -4 }]}>
        <Text style={{ fontSize: 13, fontFamily: font.medium, fontWeight: "500", color: colors.onSurfaceSecondary }}>Grand total</Text>
        <Text style={{ fontSize: 22, fontFamily: font.regular, letterSpacing: -0.4, color: colors.onSurface, fontVariant: ["tabular-nums"] }}>{money(b.totals.grand)}</Text>
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Finish and review quotation"
        accessibilityState={{ disabled: !canFinish }}
        testID="finish-quotation-btn"
        onPress={b.finalize}
        disabled={!canFinish}
        style={({ pressed }) => [styles.saveBtn, { opacity: !canFinish ? 0.4 : pressed ? 0.9 : 1 }]}
      >
        <Feather name="check" size={16} color={colors.onBrand} />
        <Text style={styles.saveBtnText}>Finish & review</Text>
      </Pressable>
    </View>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <View style={styles.tRow}>
      <Text style={type.caption}>{label}</Text>
      <Text style={[{ fontFamily: font.regular, fontVariant: ["tabular-nums"] as any, fontSize: 13, color: colors.onSurface }, valueColor ? { color: valueColor } : null]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    padding: spacing.md, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface, gap: spacing.md,
  },
  notes: {
    flexDirection: "row", alignItems: "flex-start", gap: 8, padding: 10,
    backgroundColor: colors.surfaceTertiary, borderRadius: radius.md,
  },
  notesInput: { flex: 1, fontSize: 13, color: colors.onSurface, padding: 0, minHeight: 20, maxHeight: 84 },
  discBar: {
    flexDirection: "row", alignItems: "center", gap: 8, padding: 10,
    backgroundColor: colors.surfaceTertiary, borderRadius: radius.md,
  },
  totals: { gap: 4 },
  tRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  saveBtn: {
    backgroundColor: ds.brass, paddingVertical: 14, borderRadius: radius.md,
    flexDirection: "row", justifyContent: "center", alignItems: "center", gap: 8,
  },
  saveBtnText: { color: ds.canvas, fontSize: 15, fontFamily: font.semibold, fontWeight: "600", letterSpacing: -0.1 },

  // ---- Phone-only compact/expandable footer ----
  phoneWrap: { borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface },
  phoneExpanded: {
    padding: spacing.md, gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  phoneBar: { gap: 8, paddingHorizontal: spacing.md, paddingTop: spacing.md },
  phoneSummary: { minHeight: 44, justifyContent: "center" },
  phoneActions: { flexDirection: "row", gap: 8 },
  phoneTotal: { fontSize: 19, fontFamily: font.regular, letterSpacing: -0.3, color: colors.onSurface, fontVariant: ["tabular-nums"] },
  secondary: {
    flexDirection: "row", alignItems: "center", gap: 6,
    minHeight: 44, flex: 1, justifyContent: "center", paddingHorizontal: 14, paddingVertical: 10, borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: colors.border,
  },
  secondaryText: { fontSize: 13, fontWeight: "600", color: colors.onSurface },
  primary: {
    flexDirection: "row", alignItems: "center", gap: 6,
    minHeight: 44, flex: 1, justifyContent: "center", paddingHorizontal: 16, paddingVertical: 10, borderRadius: radius.md,
    backgroundColor: ds.brass,
  },
  saveBtnTextSm: { color: ds.canvas, fontSize: 13, fontFamily: font.semibold, fontWeight: "600" },
});
