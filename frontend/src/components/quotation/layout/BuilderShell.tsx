// BuilderShell V4
// -----------------------------------------------------------------------------
// Three-column workspace inspired by the Forge V4 mockup:
//   [Brand rail 240] · [Product Explorer flex] · [Quotation panel 460]
//
// Responsive strategy (measured on container width, not window):
//   * width >= 1180  → full V4 (BrandRail + Explorer + Quotation)
//   * width >= 820   → BrandRail + Quotation, Explorer opens as picker sheet
//   * else           → Mobile: Quotation only + FAB → picker sheet, product modal
// -----------------------------------------------------------------------------
import { useEffect, useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, LayoutChangeEvent, Platform, Pressable, StyleSheet, Text, View } from "react-native";

import { colors } from "@/src/theme/tokens";
import { quotationBuilderLayout } from "@/src/design/responsive";
import { storage } from "@/src/utils/storage";

import { useBuilder } from "../context/BuilderContext";
import { BrandRail } from "../catalog/BrandRail";
import { ProductExplorer } from "../catalog/ProductExplorer";
import { QuotationPane } from "../panes/QuotationPane";
import { AssistantSheet } from "../sheets/AssistantSheet";
import { CustomProductSheet } from "../sheets/CustomProductSheet";
import { CustomerSwitcherSheet } from "../sheets/CustomerSwitcherSheet";
import { DescriptionSheet } from "../sheets/DescriptionSheet";
import { DiscountSheet } from "../sheets/DiscountSheet";
import { ProductModal } from "../sheets/ProductModal";
import { ProductPickerSheet } from "../sheets/ProductPickerSheet";
import { ReferrerSwitcherSheet } from "../sheets/ReferrerSwitcherSheet";
import { RoomSheet } from "../sheets/RoomSheet";
import { SwapSheet } from "../sheets/SwapSheet";
import { BuilderTopbar } from "./BuilderTopbar";

export function BuilderShell({ onBack }: { onBack: () => void }) {
  const b = useBuilder();
  const [w, setW] = useState(0);
  const [railCollapsed, setRailCollapsed] = useState(false);

  useEffect(() => {
    void storage.getItem<boolean>("forge.builder.brandRail.collapsed.v1", false).then((value) => {
      setRailCollapsed(value === true);
    });
  }, []);

  const toggleRail = () => {
    setRailCollapsed((current) => {
      const next = !current;
      void storage.setItem("forge.builder.brandRail.collapsed.v1", next);
      return next;
    });
  };

  const onLayout = (e: LayoutChangeEvent) => setW(e.nativeEvent.layout.width);

  const { threePane, twoPane, railWidth: railW, quotationWidth: quotationW } = quotationBuilderLayout(w, railCollapsed);
  const isPhone = !threePane && !twoPane;
  // The catalog grid (ProductExplorer) only renders inline in the threePane
  // layout — everywhere else it lives inside ProductPickerSheet and needs an
  // explicit "Add"/"Browse catalog" entry point. QuotationPane's children
  // (BuilderFooter, QuotationCanvas) previously derived their own "isPhone"
  // from raw window width via useBreakpoint(), which disagreed with this
  // container-width-based calculation (window width stays >=700/900 at
  // tablet sizes even though the *content area* — after the admin shell's
  // own sidebar — has already dropped into the twoPane/isPhone bucket here).
  // That mismatch meant tablet widths rendered the compact single-column
  // shell but the desktop-style footer/empty-state with no way to open the
  // picker sheet at all. Passing this one flag down removes the ambiguity.
  const compactCatalog = !threePane;

  // On smaller layouts, when a line/product gets focused, open the Assistant sheet.
  useEffect(() => {
    if (threePane) return;
    if (b.assistantFocus) b.setAssistantOpenMobile(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [b.assistantFocus, threePane]);

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1, backgroundColor: colors.surface }}
      onLayout={onLayout}
    >
      <BuilderTopbar onBack={onBack} isPhone={isPhone} isDesktop={threePane} />

      {b.referenceError ? (
        <View style={styles.referenceError} testID="builder-reference-error">
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.referenceErrorTitle}>Quotation data did not load</Text>
            <Text style={styles.referenceErrorBody} numberOfLines={2}>{b.referenceError}</Text>
          </View>
          <Pressable
            onPress={b.retryReferenceData}
            style={({ pressed }) => [styles.retryButton, pressed && { opacity: 0.72 }]}
            accessibilityRole="button"
            testID="builder-reference-retry"
          >
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </View>
      ) : b.referenceLoading ? (
        <View style={styles.referenceLoading} testID="builder-reference-loading">
          <ActivityIndicator size="small" color={colors.onSurfaceMuted} />
          <Text style={styles.referenceLoadingText}>Loading brands and customers…</Text>
        </View>
      ) : null}

      {w === 0 ? (
        <View style={{ flex: 1, backgroundColor: colors.surface }} />
      ) : threePane ? (
        <View style={{ flex: 1, flexDirection: "row", minHeight: 0, overflow: "hidden" }}>
          <View style={{ width: railW, overflow: "hidden" }}>
            <BrandRail collapsed={railCollapsed} onToggleCollapsed={toggleRail} compact={false} />
          </View>
          <View style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
            {/* The rail owns brand/category navigation while the explorer is
                inline. Do not let the explorer infer a phone layout from its
                narrow middle-column width: that created a second brand panel
                above the grid. */}
            <ProductExplorer showCompactFilters={false} />
          </View>
          <View style={{ width: quotationW, minHeight: 0, overflow: "hidden", borderLeftWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
            <QuotationPane compact={false} />
          </View>
        </View>
      ) : twoPane ? (
        <View style={{ flex: 1, flexDirection: "row", minHeight: 0, overflow: "hidden" }}>
          <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}><ProductExplorer showCompactFilters /></View>
          <View style={{ width: 340, minHeight: 0, borderLeftWidth: StyleSheet.hairlineWidth, borderColor: colors.border }}>
            <QuotationPane compact />
          </View>
        </View>
      ) : (
        <View style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
          <QuotationPane compact={compactCatalog} browseInline />
        </View>
      )}

      {/* Universal sheets */}
      <ProductModal />
      <CustomProductSheet />
      <CustomerSwitcherSheet />
      <ReferrerSwitcherSheet />
      <DiscountSheet />
      <RoomSheet />
      <DescriptionSheet />
      <SwapSheet />

      {/* Mobile / tablet-only sheets */}
      {isPhone || twoPane ? <ProductPickerSheet /> : null}
      {(isPhone || twoPane) && !threePane ? <AssistantSheet /> : null}
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  referenceLoading: {
    minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    paddingHorizontal: 16, backgroundColor: colors.surfaceSecondary,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  referenceLoadingText: { fontSize: 12, color: colors.onSurfaceMuted },
  referenceError: {
    minHeight: 56, flexDirection: "row", alignItems: "center", gap: 12,
    paddingHorizontal: 16, paddingVertical: 6, backgroundColor: colors.surfaceSecondary,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.error,
  },
  referenceErrorTitle: { fontSize: 13, fontWeight: "700", color: colors.onSurface },
  referenceErrorBody: { fontSize: 11, color: colors.onSurfaceMuted, marginTop: 2 },
  retryButton: {
    minWidth: 72, minHeight: 44, paddingHorizontal: 14, borderRadius: 10,
    alignItems: "center", justifyContent: "center", backgroundColor: colors.onSurface,
  },
  retryLabel: { fontSize: 13, fontWeight: "700", color: colors.surface },
});
