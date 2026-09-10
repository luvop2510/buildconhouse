// BuilderTopbar V4
// -----------------------------------------------------------------------------
// Full-width top bar with:
//   [Back] [Quotation# + save state]  [Customer · Phone · Project · Reference]  [Undo/Redo · Kb Hint · Preview · Place Order]
//
// Header fields are inline TextInputs so the salesperson never leaves the
// builder to fill them in. Values persist via BuilderContext (undoable +
// autosaved).
// -----------------------------------------------------------------------------
import { Feather } from "@expo/vector-icons";
import { useState } from "react";
import { Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { colors, radius, spacing, statusMeta, type } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";
import { BottomSheet } from "@/src/components/BottomSheet";
import { RecentQuotationsPanel } from "../panes/RecentQuotationsPanel";
import { ConfirmDialog } from "@/src/components/ds";
import { canManageDestructiveData } from "@/src/constants/roles";
import { useAuth } from "@/src/state/auth";

import { useBuilder } from "../context/BuilderContext";

// isPhone/isDesktop are measured off the builder's own container width by
// BuilderShell (threePane/twoPane/isPhone), not off raw window width via
// useBreakpoint() — the admin shell's sidebar eats into the available width,
// so a window that's plenty wide can still leave this topbar with phone-
// sized real estate. Using the container measurement keeps this in sync with
// the rest of the builder (see BuilderShell.tsx's compactCatalog comment).
export function BuilderTopbar({
  onBack, isPhone, isDesktop,
}: {
  onBack: () => void; isPhone: boolean; isDesktop: boolean;
}) {
  const b = useBuilder();
  const { staff } = useAuth();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);

  const revs = b.recentQuotations.find((q) => q.id === b.quotationId)?.revision_count ?? 0;
  const status = b.recentQuotations.find((q) => q.id === b.quotationId)?.status || "draft";
  const meta = statusMeta[status] || statusMeta.draft;

  return (
    <View style={styles.bar}>
      <Pressable testID="builder-back" accessibilityRole="button" accessibilityLabel="Back to quotations" onPress={onBack} style={styles.back} hitSlop={6}>
        <Feather name="chevron-left" size={18} color={colors.onSurface} />
        {!isPhone ? <Text style={styles.backLabel}>Back</Text> : null}
      </Pressable>

      <View style={styles.titleCol}>
        <View style={styles.titleRow}>
          <Text style={[type.titleMd, styles.titleText]} numberOfLines={1}>
            {b.quotationNumber || "New quotation"}
          </Text>
          <View style={[styles.statusPill, { backgroundColor: meta.bg }]}>
            <Text style={[styles.statusText, { color: meta.fg }]}>{meta.label}</Text>
          </View>
          {!isPhone && revs > 0 ? (
            <View style={styles.revPill}>
              <Feather name="git-branch" size={10} color={colors.onSurfaceMuted} />
              <Text style={styles.revText}>Rev {revs}</Text>
            </View>
          ) : null}
        </View>
        <Text
          style={[type.caption, { color: b.saveState === "error" ? colors.error : colors.onSurfaceMuted }]}
          testID="save-status"
        >
          {b.saveLabel}
          {b.history.pastSize > 0 ? ` · ${b.history.pastSize} step${b.history.pastSize === 1 ? "" : "s"}` : ""}
        </Text>
      </View>

      {isPhone ? <Pressable accessibilityRole="button" accessibilityLabel="Quotation actions" onPress={() => setActionsOpen(true)} style={styles.iconBtn} testID="builder-actions">
        <Feather name="more-horizontal" size={20} color={colors.onSurface} />
      </Pressable> : null}
      {!isPhone ? <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
        {/* On phone, keep only the order action here. The persistent checkout
            footer owns draft completion; suppressing secondary actions avoids
            squeezing six touch targets into one row. */}
        {!isPhone ? <Pressable
          accessibilityRole="button" accessibilityLabel="Generate quotation"
          testID="generate-quotation"
          onPress={b.generateOfficialQuotation}
          disabled={b.workflowBusy || b.s.lines.length === 0}
          style={({ pressed }) => [styles.workflowBtn, styles.quotationBtn, { opacity: b.workflowBusy || b.s.lines.length === 0 ? 0.45 : pressed ? 0.76 : 1 }]}
        >
          <Feather name="file-text" size={14} color={colors.onSurface} />
          {isPhone ? null : <Text style={styles.workflowText}>Quotation</Text>}
        </Pressable> : null}
        <Pressable
          accessibilityRole="button" accessibilityLabel="Place order"
          testID="place-order"
          onPress={b.placeOrder}
          disabled={b.workflowBusy || b.s.lines.length === 0}
          style={({ pressed }) => [styles.workflowBtn, styles.orderBtn, { opacity: b.workflowBusy || b.s.lines.length === 0 ? 0.45 : pressed ? 0.76 : 1 }]}
        >
          <Feather name="shopping-cart" size={14} color={colors.onBrand} />
          {isPhone ? null : <Text style={[styles.workflowText, { color: colors.onBrand }]}>Place Order</Text>}
        </Pressable>
      </View> : null}
      {!isPhone ? <View style={{ flexDirection: "row", gap: 4, alignItems: "center" }}>
        {isDesktop && Platform.OS === "web" ? (
          <View style={styles.hint} testID="shortcut-hint">
            <Text style={styles.hintKey}>⌘Z</Text>
            <Text style={styles.hintSep}>·</Text>
            <Text style={styles.hintKey}>⇧⌘Z</Text>
            <Text style={styles.hintSep}>·</Text>
            <Text style={styles.hintKey}>⌘K</Text>
          </View>
        ) : null}
        {!isPhone ? <Pressable
          accessibilityRole="button" accessibilityLabel="Undo last change"
          testID="undo-btn"
          onPress={b.history.undo}
          disabled={!b.history.canUndo}
          style={({ pressed }) => [styles.iconBtn, { opacity: !b.history.canUndo ? 0.35 : pressed ? 0.7 : 1 }]}
          hitSlop={6}
        >
          <Feather name="corner-up-left" size={16} color={colors.onSurface} />
        </Pressable> : null}
        {!isPhone ? <Pressable
          accessibilityRole="button" accessibilityLabel="Redo change"
          testID="redo-btn"
          onPress={b.history.redo}
          disabled={!b.history.canRedo}
          style={({ pressed }) => [styles.iconBtn, { opacity: !b.history.canRedo ? 0.35 : pressed ? 0.7 : 1 }]}
          hitSlop={6}
        >
          <Feather name="corner-up-right" size={16} color={colors.onSurface} />
        </Pressable> : null}
        {canManageDestructiveData(staff?.role) && b.quotationId ? (
          <Pressable
            testID="builder-delete-quotation"
            onPress={() => setDeleteOpen(true)}
            style={({ pressed }) => [styles.iconBtn, { opacity: pressed ? 0.7 : 1 }]}
            hitSlop={6}
            accessibilityLabel="Delete quotation"
          >
            <Feather name="trash-2" size={16} color={colors.error} />
          </Pressable>
        ) : null}
        {!isDesktop ? <Pressable accessibilityRole="button" accessibilityLabel="Recent quotations" style={styles.iconBtn} onPress={() => setRecentOpen(true)}><Feather name="clock" size={16} color={colors.onSurface} /></Pressable> : null}
      </View> : null}
      <BottomSheet visible={actionsOpen} onClose={() => setActionsOpen(false)} title="Quotation actions" testID="quotation-actions-sheet">
        <View style={{ gap: 8 }}>
          {[
            { label: "Undo last change", icon: "corner-up-left" as const, action: b.history.undo, disabled: !b.history.canUndo },
            { label: "Redo change", icon: "corner-up-right" as const, action: b.history.redo, disabled: !b.history.canRedo },
            { label: "Generate quotation", icon: "file-text" as const, action: b.generateOfficialQuotation, disabled: b.workflowBusy || !b.s.lines.length },
            { label: "Place order", icon: "shopping-cart" as const, action: b.placeOrder, disabled: b.workflowBusy || !b.s.lines.length },
            { label: "Recent quotations", icon: "clock" as const, action: () => setRecentOpen(true), disabled: false },
          ].map(item => <Pressable key={item.label} accessibilityRole="button" accessibilityState={{ disabled: item.disabled }} disabled={item.disabled}
            onPress={() => { setActionsOpen(false); item.action(); }} style={[styles.actionRow, item.disabled && { opacity: 0.4 }]}>
            <Feather name={item.icon} size={18} color={colors.onSurface} /><Text style={styles.actionLabel}>{item.label}</Text>
          </Pressable>)}
          {canManageDestructiveData(staff?.role) && b.quotationId ? <Pressable accessibilityRole="button" accessibilityLabel="Delete quotation" onPress={() => { setActionsOpen(false); setDeleteOpen(true); }} style={styles.actionRow}>
            <Feather name="trash-2" size={18} color={colors.error} /><Text style={[styles.actionLabel, { color: colors.error }]}>Delete quotation</Text>
          </Pressable> : null}
        </View>
      </BottomSheet>
      <BottomSheet visible={recentOpen} onClose={() => setRecentOpen(false)} title="Recent quotations" testID="builder-recent-sheet">
        <RecentQuotationsPanel onLoaded={() => setRecentOpen(false)} />
      </BottomSheet>
      <ConfirmDialog
        visible={deleteOpen}
        onClose={() => { if (!deleting) setDeleteOpen(false); }}
        onConfirm={async () => {
          setDeleting(true);
          try {
            await b.deleteQuotation();
            setDeleteOpen(false);
          } finally {
            setDeleting(false);
          }
        }}
        title="Delete quotation?"
        description="This removes the quotation and unpaid workflow records. Completed payments and purchase orders are protected."
        confirmLabel="Delete"
        tone="danger"
        loading={deleting}
        testID="confirm-delete-active-builder-quotation"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  actionRow: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 12 },
  actionLabel: { fontSize: 15, fontWeight: "600", color: colors.onSurface },
  bar: {
    flexDirection: "row", alignItems: "center", paddingHorizontal: spacing.lg,
    paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary, gap: 10,
  },
  back: { minWidth: 44, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 3 },
  backLabel: { fontSize: 13, fontWeight: "500", color: colors.onSurface },
  // The mobile topbar keeps the action icons visible, so the title block must
  // be allowed to give up intrinsic width instead of pushing undo/redo past
  // the viewport edge.
  titleCol: { flex: 1, minWidth: 0, gap: 2 },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 6, minWidth: 0 },
  titleText: { flexShrink: 1 },
  numPill: {
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: colors.surfaceTertiary,
  },
  numPillText: { fontSize: 11, fontWeight: "700", color: colors.onSurface, fontVariant: ["tabular-nums"] },
  statusPill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999 },
  statusText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4 },
  revPill: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 3, borderRadius: 999, backgroundColor: colors.surfaceTertiary,
  },
  revText: { fontSize: 10, fontWeight: "700", color: colors.onSurfaceMuted, letterSpacing: 0.3 },

  headerFieldsRow: {
    flex: 1, marginLeft: spacing.lg,
  },
  headerFieldsRowContent: {
    flexDirection: "row", gap: 8, alignItems: "center", flexGrow: 1, justifyContent: "flex-end",
  },
  field: {
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface, minWidth: 108, maxWidth: 200,
  },
  fieldFocused: { borderColor: ds.brass, backgroundColor: ds.brassTint },
  fieldPressable: {},
  fieldPressed: { borderColor: ds.brassLine, backgroundColor: ds.brassTint },
  fieldLabel: { fontSize: 9, fontWeight: "700", color: colors.onSurfaceMuted, letterSpacing: 0.8, textTransform: "uppercase" },
  fieldValue: { fontSize: 12, fontWeight: "600", color: colors.onSurface, marginTop: 1 },
  fieldInput: { fontSize: 12, fontWeight: "600", color: colors.onSurface, padding: 0, marginTop: 1, borderWidth: 0 },

  workflowBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, minWidth: 44, height: 44, paddingHorizontal: 10, borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth },
  quotationBtn: { backgroundColor: colors.surface, borderColor: colors.border },
  orderBtn: { backgroundColor: colors.brand, borderColor: colors.brand },
  workflowText: { fontSize: 12, fontWeight: "700", color: colors.onSurface },
  iconBtn: {
    width: 44, height: 44, alignItems: "center", justifyContent: "center", borderRadius: radius.md,
    backgroundColor: colors.surfaceTertiary,
  },
  hint: {
    flexDirection: "row", alignItems: "center", gap: 4,
    paddingHorizontal: 8, paddingVertical: 4, borderRadius: 6,
    backgroundColor: colors.surfaceTertiary, marginRight: 4,
  },
  hintKey: { fontSize: 10, fontWeight: "700", color: colors.onSurfaceSecondary, fontVariant: ["tabular-nums"] },
  hintSep: { fontSize: 10, color: colors.onSurfaceMuted },
});
