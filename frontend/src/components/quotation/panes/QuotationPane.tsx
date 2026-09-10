// QuotationPane V4 — the right pane in the V4 shell.
// Renders: sticky header (number + save state + status), room chip row, canvas
// (rooms + line items), footer (notes + discount + totals + place order).
//
// Customer / phone / project / reference-source live in the topbar on desktop
// and in this pane's fixed header on compact layouts, so they never disappear
// behind the quotation canvas.
import { Feather } from "@expo/vector-icons";
import { Keyboard, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View, useWindowDimensions } from "react-native";

import { useState } from "react";
import { ProductExplorer } from "../catalog/ProductExplorer";
import { colors, spacing } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { useBuilder } from "../context/BuilderContext";
import { RoomChipRow } from "../canvas/RoomChipRow";
import { QuotationCanvas } from "../canvas/QuotationCanvas";
import { BuilderFooter } from "../footer/BuilderFooter";

export function QuotationPane({ compact = false, browseInline = false }: { compact?: boolean; browseInline?: boolean }) {
  const b = useBuilder();
  const [section, setSection] = useState<"products" | "quotation">("products");
  const browsing = browseInline && section === "products";

  return (
    <View style={styles.panel} testID="quotation-workspace">
      <View style={styles.head}>
        <CustomerDetails />
        <RoomChipRow />
        {browseInline ? (
          <View style={styles.tabs} accessibilityRole="tablist">
            {(["products", "quotation"] as const).map((key) => (
              <Pressable key={key} accessibilityRole="tab" accessibilityState={{ selected: section === key }}
                testID={`builder-tab-${key}`} onPress={() => setSection(key)}
                style={[styles.tab, section === key && styles.tabSelected]}>
                <Feather name={key === "products" ? "grid" : "file-text"} size={15} color={section === key ? ds.brassDeep : colors.onSurfaceSecondary} />
                <Text style={[styles.tabLabel, section === key && { color: ds.brassDeep }]}>
                  {key === "products" ? "Products" : `Quotation · ${b.s.lines.length}`}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : <Text style={styles.sectionLabel}>Quotation · {b.s.lines.length} items</Text>}
      </View>

      {browseInline ? <View style={[styles.body, !browsing && { display: "none" }]}><ProductExplorer showCompactFilters /></View> : null}
      <View style={[styles.body, browsing && { display: "none" }]}>
        <QuotationCanvas compact={compact} />
      </View>
      <BuilderFooter compact={compact} browsing={browsing}
        onBrowse={browseInline ? () => setSection("products") : undefined}
        onReview={browseInline ? () => setSection("quotation") : undefined} />
    </View>
  );
}

function CustomerDetails() {
  const b = useBuilder();
  const [expanded, setExpanded] = useState(false);
  const { height } = useWindowDimensions();
  const customer = b.customers.find((c) => c.id === b.s.customerId);
  const collapse = () => { Keyboard.dismiss(); setExpanded(false); };

  return (
    <View style={styles.details}>
      <Pressable accessibilityRole="button" accessibilityState={{ expanded }}
        accessibilityLabel={expanded ? "Collapse customer and project details" : "Edit customer and project details"}
        testID="quotation-details-toggle" onPress={() => expanded ? collapse() : setExpanded(true)} style={styles.detailsSummary}>
        <Feather name="user" size={17} color={ds.brassDeep} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.summaryTitle} numberOfLines={1}>{customer?.company || customer?.name || "Customer & project details"}</Text>
          <Text style={styles.summarySubtitle} numberOfLines={1}>
            {customer ? [b.s.header.projectName, b.s.header.phone, b.s.header.address].filter(Boolean).join(" · ") || "Add project, address & reference" : "Add customer, address, phone & reference"}
          </Text>
        </View>
        <Text style={styles.editLabel}>{expanded ? "Hide" : "Edit"}</Text>
        <Feather name={expanded ? "chevron-up" : "chevron-down"} size={14} color={ds.brassDeep} />
      </Pressable>
      {expanded ? <>
        <ScrollView style={{ maxHeight: Math.max(120, Math.min(280, height * 0.32)) }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 10 }}>
          <CompactHeaderFields />
        </ScrollView>
        <Pressable accessibilityRole="button" testID="quotation-details-done" onPress={collapse} style={styles.done}>
          <Feather name="check" size={16} color={colors.onBrand} />
          <Text style={styles.doneLabel}>Done · continue with products</Text>
        </Pressable>
      </> : null}
    </View>
  );
}

function CompactHeaderFields() {
  const b = useBuilder();
  const customer = b.customers.find((c) => c.id === b.s.customerId);

  return (
    <View style={styles.compactFields} testID="compact-quotation-fields">
      <Pressable
        testID="compact-hdr-customer"
        onPress={() => b.setCustomerSwitcherOpen(true)}
        accessibilityRole="button" accessibilityLabel="Choose customer"
        style={[styles.compactField, styles.compactFieldWide]}
      >
        <Text style={styles.fieldLabel}>Customer</Text>
        <View style={styles.customerValueRow}>
          <Text style={styles.fieldValue} numberOfLines={1}>{customer?.company || customer?.name || "Select customer"}</Text>
          <Feather name="chevron-down" size={12} color={colors.onSurfaceMuted} />
        </View>
      </Pressable>
      <CompactTextField label="Project" value={b.s.header.projectName} onChange={b.setProjectName} placeholder="Project name" testID="compact-hdr-project" />
      <CompactTextField label="Address" value={b.s.header.address} onChange={b.setAddress} placeholder="Site / delivery address" testID="compact-hdr-address" wide />
      <CompactTextField label="Phone" value={b.s.header.phone} onChange={b.setPhone} placeholder="+91 ·········" testID="compact-hdr-phone" />
      <CompactTextField label="Reference" value={b.s.header.referenceSource} onChange={b.setReferenceSource} placeholder="Walk-in · Architect" testID="compact-hdr-ref" />
      <Pressable
        testID="compact-hdr-referrer"
        onPress={() => b.setReferrerSwitcherOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Choose referrer"
        style={({ pressed }) => [styles.compactField, styles.compactFieldWide, pressed && styles.compactFieldPressed]}
      >
        <Text style={styles.fieldLabel}>Referred by</Text>
        <View style={styles.customerValueRow}>
          <Text style={styles.fieldValue} numberOfLines={1}>{b.s.header.referrerName || "None"}</Text>
          <Feather name="chevron-down" size={12} color={colors.onSurfaceMuted} />
        </View>
      </Pressable>
    </View>
  );
}

function CompactTextField({
  label, value, onChange, placeholder, testID, wide = false,
}: {
  label: string; value: string; onChange: (value: string) => void; placeholder: string; testID: string; wide?: boolean;
}) {
  return (
    <View style={[styles.compactField, wide && styles.compactFieldWide]}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChange}
        placeholder={placeholder}
        placeholderTextColor={colors.onSurfaceMuted}
        accessibilityLabel={label}
        keyboardType={label === "Phone" ? "phone-pad" : "default"}
        numberOfLines={1}
        style={[styles.fieldInput, Platform.OS === "web" && ({ outlineStyle: "none" } as any)]}
        testID={testID}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, overflow: "hidden", backgroundColor: colors.surfaceSecondary },
  head: {
    padding: spacing.md, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary, gap: spacing.sm,
  },
  body: { flex: 1, minHeight: 0, overflow: "hidden" },
  details: { borderWidth: 1, borderColor: colors.border, borderRadius: 12, overflow: "hidden", backgroundColor: colors.surface },
  detailsSummary: { flexDirection: "row", alignItems: "center", gap: 9, minHeight: 60, padding: 10 },
  summaryTitle: { fontSize: 13, fontWeight: "700", color: colors.onSurface },
  summarySubtitle: { fontSize: 11, color: colors.onSurfaceSecondary, marginTop: 3 },
  editLabel: { fontSize: 12, fontWeight: "700", color: ds.brassDeep },
  done: { minHeight: 44, margin: 10, marginTop: 0, borderRadius: 8, backgroundColor: colors.brand, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center" },
  doneLabel: { fontSize: 13, fontWeight: "700", color: colors.onBrand },
  tabs: { flexDirection: "row", padding: 3, borderRadius: 10, backgroundColor: colors.surfaceTertiary },
  tab: { flex: 1, minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 8 },
  tabSelected: { backgroundColor: colors.surface },
  tabLabel: { fontSize: 13, fontWeight: "700", color: colors.onSurfaceSecondary },
  sectionLabel: { fontSize: 13, fontWeight: "700", color: colors.onSurface },
  customerLine: { fontSize: 12, fontWeight: "600", color: colors.onSurfaceSecondary, marginTop: 4 },
  compactFields: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  compactField: {
    flexGrow: 1, flexBasis: "47%", minWidth: 0, minHeight: 44, paddingHorizontal: 9, paddingVertical: 6,
    borderRadius: 8, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface,
  },
  compactFieldWide: { flexBasis: "100%" },
  compactFieldPressed: { backgroundColor: colors.surfaceTertiary },
  fieldLabel: { fontSize: 10, fontWeight: "700", color: colors.onSurfaceSecondary, letterSpacing: 0.7, textTransform: "uppercase" },
  fieldValue: { flex: 1, minWidth: 0, marginTop: 1, fontSize: 12, fontWeight: "600", color: colors.onSurface },
  fieldInput: { padding: 0, marginTop: 1, fontSize: 16, fontWeight: "500", color: colors.onSurface, minHeight: 28 },
  customerValueRow: { flexDirection: "row", alignItems: "center", gap: 4 },
});
