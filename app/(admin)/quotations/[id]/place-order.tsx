// Place Order — Review & Confirm
// -----------------------------------------------------------------------------
// Renders brand-grouped preview cards for an approved quotation. Each card shows
// the items that will land on a single Purchase Order, with an editable
// supplier assignment and optional internal notes.
//
// Confirm → POST /quotations/:id/place-order/confirm → server creates one PO
// per brand, marks the quotation `ordered`, then we route to /purchase-orders.
// -----------------------------------------------------------------------------
import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter, useSegments } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { Alert, Button, Card, ErrorState, LoadingState, PageHeader } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { api } from "@/src/api/client";
import { colors, money, radius, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";
import { TILES_FLOOR_ID } from "@/src/constants/floors";
import { Sheet } from "@/src/design/components";
import { downloadApiFile } from "@/src/utils/downloadFile";

type PreviewItem = {
  line_id: string;
  product_id: string;
  sku: string;
  name: string;
  room?: string | null;
  qty: number;
  unit_cost: number;
  quantity_unit?: "Box" | "Pieces";
  size?: string | null;
  pcs_per_box?: string | number | null;
};

type BrandCard = {
  brand_id: string | null;
  brand_name: string;
  items: PreviewItem[];
  subtotal: number;
  item_count: number;
  default_supplier?: { id: string; name: string } | null;
};

type Preview = {
  quotation_id: string;
  quotation_number: string;
  doc_type: "standard" | "tiles_selection" | "tiles_quotation";
  customer_id: string;
  customer_name: string;
  brands: BrandCard[];
  total_value: number;
  godown_matches?: GodownMatch[];
};

type GodownMatch = { line_id: string; product_id: string; sku: string; name: string; requested_qty: number; available_qty: number; replaceable_qty: number; source_customers: string[] };

type Supplier = { id: string; name: string; brand_id?: string | null; brand_name?: string | null };

export default function PlaceOrderReview() {
  const { id, floor } = useLocalSearchParams<{ id: string; floor?: string }>();
  const segments = useSegments() as string[];
  const router = useRouter();
  const { isPhone } = useBp();
  const insets = useSafeAreaInsets();

  const [preview, setPreview] = useState<Preview | null>(null);
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierByBrand, setSupplierByBrand] = useState<Record<string, string>>({});
  const [expandedBrands, setExpandedBrands] = useState<Record<string, boolean>>({});
  const [notesByBrand, setNotesByBrand] = useState<Record<string, string>>({});
  const [expected, setExpected] = useState<string>("");
  const [projectName, setProjectName] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [godownPromptOpen, setGodownPromptOpen] = useState(false);
  const [godownBusy, setGodownBusy] = useState(false);
  // The Ground Floor has a dedicated alias beneath /tiles so it never enters
  // the Sanitary-only quotation route family. Keep the query-param fallback
  // for saved deep links created before that route existed.
  const floorId = floor === TILES_FLOOR_ID || segments.includes("tiles") ? TILES_FLOOR_ID : undefined;

  const loadPreview = useCallback(async () => {
    setError(null);
    try {
      const [p, s] = await Promise.all([
        api.get<Preview>(`/quotations/${id}/place-order/preview`, { floorId }),
        api.get<Supplier[]>("/suppliers", { floorId }),
      ]);
      setPreview(p);
      setSuppliers(s);
      const defaults: Record<string, string> = {};
      for (const b of p.brands) {
        if (b.default_supplier && b.brand_id) defaults[b.brand_id] = b.default_supplier.id;
      }
      setSupplierByBrand(defaults);
      setGodownPromptOpen((p.godown_matches || []).length > 0);
    } catch (e: any) {
      setError(e?.detail || "Failed to load preview");
    }
  }, [floorId, id]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const supplierOptionsFor = useCallback(
    (brand_id: string | null): Supplier[] => {
      if (!brand_id) return suppliers;
      const matched = suppliers.filter((s) => s.brand_id === brand_id);
      return matched.length ? matched : suppliers;
    },
    [suppliers],
  );

  const confirm = async () => {
    if (!preview || busy) return;
    setConfirmError(null); setBusy(true);
    try {
      const res = await api.post<{ purchase_orders: { id: string }[]; count: number }>(
        `/quotations/${id}/place-order/confirm`,
        {
          supplier_by_brand: supplierByBrand,
          notes_by_brand: notesByBrand,
          expected_delivery_at: expected || null,
          project_name: projectName || null,
        }, { floorId },
      );
      toast.success(`Order placed · ${res.count} Purchase Orders created`);
      const isTilesDoc = preview.doc_type === "tiles_selection" || preview.doc_type === "tiles_quotation";
      router.replace((isTilesDoc ? "/(admin)/tiles/orders" : "/(admin)/purchases") as any);
    } catch (e: any) {
      setConfirmError(e?.detail || "Could not place order. Your supplier choices and notes are still here.");
    } finally {
      setBusy(false);
    }
  };

  const useGodownStock = async () => {
    setGodownBusy(true);
    try {
      const result = await api.post<{ replacements: number }>(`/quotations/${id}/use-godown-stock`, {}, { floorId });
      toast.success(`${result.replacements} godown stock lot${result.replacements === 1 ? "" : "s"} reserved and sent to In Box`);
      setGodownPromptOpen(false);
      await loadPreview();
    } catch (e: any) {
      toast.error(e?.detail || "Could not reserve godown stock");
    } finally { setGodownBusy(false); }
  };

  if (error) {
    return (
      <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
        <PageHeader title="Review order" back={() => router.back()} />
        <ErrorState title="Could not prepare order" subtitle={error} onRetry={() => void loadPreview()} />
      </SafeAreaView>
    );
  }

  if (!preview) {
    return <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}><PageHeader title="Review order" back={() => router.back()} /><LoadingState label="Preparing items, brands and suppliers…" /></SafeAreaView>;
  }

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      <PageHeader title="Review order" subtitle={preview.quotation_number} back={() => router.back()} />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 0 : 24}
      >
        <ScrollView contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, gap: spacing.lg, paddingBottom: spacing.xxxl + insets.bottom }} keyboardShouldPersistTaps="handled">
        {confirmError ? <Alert tone="error" title="Order not placed" description={confirmError} /> : null}
        {/* Header summary */}
        <View>
          <Text accessibilityRole="header" aria-level={2} style={type.titleLg}>{preview.customer_name}</Text>
          <Text style={[type.bodyMuted, { marginTop: 4 }]}>
            {preview.brands.length} brand{preview.brands.length !== 1 ? "s" : ""} · {preview.brands.reduce((s, b) => s + b.item_count, 0)} items · {money(preview.total_value)}
          </Text>
          {preview.doc_type === "standard" ? <Pressable
            accessibilityRole="button"
            accessibilityLabel="Download customer product PPT"
            testID="review-download-ppt"
            onPress={() => {
              const name = (preview.customer_name || "Customer").replace(/[\\/:*?"<>|]/g, "").trim().replace(/\s+/g, " ") || "Customer";
              const date = new Date().toLocaleDateString("en-GB").replace(/\//g, "-");
              void downloadApiFile(`/quotations/${id}/pptx`, `${name} PPT ${date}.pptx`, "product PPT", floorId);
            }}
            style={{ alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 7, minHeight: 44, marginTop: 8, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border }}
          >
            <Feather name="image" size={16} color={colors.onSurface} />
            <Text style={{ color: colors.onSurface, fontSize: 13, fontWeight: "600" }}>Product PPT</Text>
          </Pressable> : null}
        </View>

        {/* Project / delivery */}
        <Card>
          <Text style={type.overline}>Order details</Text>
          <View style={{ marginTop: spacing.md, gap: spacing.md }}>
            <View>
              <Text style={styles.label}>Project name (optional)</Text>
              <TextInput
                value={projectName}
                onChangeText={setProjectName}
                placeholder="e.g. Sea View Villa – Alibaug"
                placeholderTextColor={colors.onSurfaceMuted}
                style={styles.textInput}
                testID="project-name" accessibilityLabel="Project name"
              />
            </View>
            <View>
              <Text style={styles.label}>Expected delivery (optional)</Text>
              <TextInput
                value={expected}
                onChangeText={setExpected}
                placeholder="YYYY-MM-DD"
                placeholderTextColor={colors.onSurfaceMuted}
                style={styles.textInput}
                testID="expected-delivery" accessibilityLabel="Expected delivery"
              />
            </View>
          </View>
        </Card>

        {/* Brand cards */}
        {preview.brands.map((b) => {
          const brandKey = b.brand_id || "__unassigned__";
          const options = supplierOptionsFor(b.brand_id);
          const selectedSupplier = supplierByBrand[brandKey];
          return (
            <Card key={brandKey}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start" }}>
                <View>
                  <Text style={type.overline}>Purchase Order · {b.brand_name}</Text>
                  <Text style={{ fontSize: 18, fontWeight: "700", color: colors.onSurface, marginTop: 4 }}>{b.brand_name}</Text>
                  <Text style={type.caption}>{b.item_count} items</Text>
                </View>
                <View style={{ alignItems: "flex-end" }}>
                  <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>Subtotal</Text>
                  <Text style={[type.mono, { fontSize: 15, fontWeight: "700", marginTop: 2 }]} numberOfLines={1}>{money(b.subtotal)}</Text>
                </View>
              </View>

              <View style={styles.itemsBox}>
                {b.items.slice(0, expandedBrands[brandKey] ? undefined : 6).map((it) => (
                  <View key={it.line_id} style={[styles.itemRow, isPhone && styles.itemRowPhone]}>
                    <View style={styles.itemIdentity}>
                      <Text style={[type.mono, styles.itemSku]} numberOfLines={1}>{it.sku}</Text>
                      <Text style={{ fontSize: 12, fontWeight: "500" }} numberOfLines={1}>{it.name}</Text>
                      {it.room ? <Text style={type.caption}>{it.room}</Text> : null}
                    </View>
                    <View style={styles.itemAmounts}>
                      <Text style={[type.mono, styles.itemQty]}>{it.qty} {it.quantity_unit === "Pieces" ? "pieces" : "boxes"}</Text>
                      {it.size || it.pcs_per_box ? <Text style={type.caption}>{[it.size, it.pcs_per_box ? `${it.pcs_per_box} per box` : null].filter(Boolean).join(" · ")}</Text> : null}
                      <Text style={[type.mono, styles.itemAmount]} numberOfLines={1}>{money(it.unit_cost * it.qty)}</Text>
                    </View>
                  </View>
                ))}
                {b.items.length > 6 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: Boolean(expandedBrands[brandKey]) }}
                    accessibilityLabel={`Show ${b.items.length - 6} more ${b.brand_name} items`}
                    onPress={() => setExpandedBrands((current) => ({ ...current, [brandKey]: !current[brandKey] }))}
                    style={{ padding: 10 }}
                  >
                    <Text style={[type.caption, { textAlign: "center", color: colors.brand }]}>
                      {expandedBrands[brandKey] ? "Show fewer items" : `+${b.items.length - 6} more items…`}
                    </Text>
                  </Pressable>
                ) : null}
              </View>

              <View style={{ gap: spacing.md, marginTop: spacing.md }}>
                <View>
                  <Text style={styles.label}>Supplier</Text>
                  <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingVertical: 4 }}>
                    {options.length === 0 ? (
                      <Text style={type.caption}>No suppliers configured — add one from Settings</Text>
                    ) : (
                      options.map((s) => {
                        const on = selectedSupplier === s.id;
                        return (
                          <Pressable
                            key={s.id}
                            testID={`supplier-${s.id}`}
                            onPress={() => setSupplierByBrand((prev) => ({ ...prev, [brandKey]: s.id }))}
                            style={[styles.supplierChip, on && { borderColor: colors.brand, backgroundColor: colors.brand }]}
                          >
                            <Feather name="truck" size={12} color={on ? colors.onBrand : colors.onSurfaceMuted} />
                            <Text style={{ fontSize: 12, fontWeight: "600", color: on ? colors.onBrand : colors.onSurface }}>{s.name}</Text>
                          </Pressable>
                        );
                      })
                    )}
                  </ScrollView>
                </View>
                <View>
                  <Text style={styles.label}>Internal notes (optional)</Text>
                  <TextInput
                    value={notesByBrand[brandKey] || ""}
                    onChangeText={(v) => setNotesByBrand((prev) => ({ ...prev, [brandKey]: v }))}
                    placeholder="e.g. Priority order, deliver by month-end"
                    placeholderTextColor={colors.onSurfaceMuted}
                    style={[styles.textInput, { minHeight: 56 }]}
                    multiline
                    testID={`notes-${brandKey}`} accessibilityLabel={`Internal notes for ${b.brand_name}`}
                  />
                </View>
              </View>
            </Card>
          );
        })}

        {/* Confirm bar */}
        <View style={[styles.confirmBar, isPhone && styles.confirmBarPhone]}>
          <View style={{ flex: 1 }}>
            <Text style={type.caption}>Total order value</Text>
            <Text style={{ fontSize: 20, fontWeight: "700", color: colors.onSurface, fontVariant: ["tabular-nums"] }} numberOfLines={1}>
              {money(preview.total_value)}
            </Text>
          </View>
          <View style={[styles.confirmActions, isPhone && styles.confirmActionsPhone]}>
            <Button label="Cancel" variant="ghost" onPress={() => router.back()} fullWidth={isPhone} />
            <Button label={`Generate ${preview.brands.length} PO${preview.brands.length !== 1 ? "s" : ""}`} icon="check" onPress={confirm} loading={busy} testID="confirm-place-order" fullWidth={isPhone} />
          </View>
        </View>
      </ScrollView>
      </KeyboardAvoidingView>
      <Sheet open={godownPromptOpen} onClose={() => setGodownPromptOpen(false)} title="Products already in Godown" width={520}
        footer={<View style={{ flexDirection: "row", gap: spacing.sm }}><Button label="Place fresh order" variant="ghost" onPress={() => setGodownPromptOpen(false)} disabled={godownBusy} fullWidth /><Button label="Use Godown stock" icon="archive" onPress={useGodownStock} loading={godownBusy} fullWidth /></View>}
      >
        <Text style={type.body}>These products are already in our Godown. Should we replace the products with our Godown stock items and not produce them, or place an order for the products we already have in Godown?</Text>
        <View style={{ marginTop: spacing.md, gap: 8 }}>
          {(preview.godown_matches || []).map((match) => <View key={match.line_id} style={styles.godownMatch}><Feather name="archive" size={15} color={colors.brand} /><View style={{ flex: 1 }}><Text style={{ fontWeight: "700", color: colors.onSurface }}>{match.name}</Text><Text style={type.caption}>{match.sku} · {match.replaceable_qty} of {match.requested_qty} available · from {match.source_customers.join(", ")}</Text></View></View>)}
        </View>
      </Sheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  topbar: {
    flexDirection: "row", alignItems: "center", justifyContent: "space-between",
    paddingHorizontal: spacing.lg, paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  label: { fontSize: 11, fontWeight: "600", textTransform: "uppercase", letterSpacing: 0.6, color: colors.onSurfaceMuted, marginBottom: 4 },
  textInput: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radius.md,
    padding: 10, fontSize: 14, backgroundColor: colors.surface, color: colors.onSurface,
  },
  itemsBox: {
    marginTop: spacing.md,
    borderRadius: radius.md, backgroundColor: colors.surfaceTertiary,
    padding: 4, gap: 2,
  },
  itemRow: {
    flexDirection: "row", alignItems: "center", gap: 8,
    paddingHorizontal: 8, paddingVertical: 6, borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
  },
  itemRowPhone: { alignItems: "flex-start" },
  itemIdentity: { flex: 1, minWidth: 0, gap: 2 },
  itemSku: { fontSize: 11, color: colors.onSurfaceMuted },
  itemAmounts: { alignItems: "flex-end", gap: 2, minWidth: 88 },
  itemQty: { fontSize: 11, textAlign: "right" },
  itemAmount: { fontSize: 12, textAlign: "right", fontWeight: "600" },
  supplierChip: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 12, height: 34, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
  },
  confirmBar: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    padding: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  confirmBarPhone: { flexDirection: "column", alignItems: "stretch" },
  confirmActions: { flexDirection: "row", alignItems: "center", gap: spacing.sm },
  confirmActionsPhone: { flexDirection: "column", alignItems: "stretch" },
  godownMatch: { flexDirection: "row", alignItems: "flex-start", gap: 9, padding: 10, borderRadius: radius.md, backgroundColor: colors.brandTint },
});
