import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View, type DimensionValue } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { addDirectGodownStock, getGodownStock, getPoFinalMatches, getSkuSuggestions, updateGodownPricing, type GodownLot, type GodownStockResponse, type PoFinalMatch, type SkuSuggestion } from "@/src/api/godownStock";
import { CustomerTransferSheet } from "@/src/components/godown/CustomerTransferSheet";
import { Sheet } from "@/src/design/components";
import { ProductImage } from "@/src/components/ProductImage";
import { ErrorState } from "@/src/components/ui";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { toast } from "@/src/components/Toast";
import { useBp } from "@/src/design/responsive";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";

const fmt = (value?: string | null) => value ? new Date(value).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit" }) : "Not recorded";
const money = (value: number) => `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

export default function GodownStockScreen() {
  const { selectedFloorId } = useFloorAccess();
  const { staff } = useAuth();
  const canEditPricing = useActionAccess("godown_stock", "update", staff?.role !== "worker");
  const router = useRouter(); const { isPhone, isDesktop } = useBp();
  const { newStockId } = useLocalSearchParams<{ newStockId?: string }>();
  const checkedStockId = useRef<string | null>(null);
  const [data, setData] = useState<GodownStockResponse | null>(null); const [q, setQ] = useState(""); const [brand, setBrand] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false); const [mode, setMode] = useState<"catalog" | "manual">("catalog");
  const [sku, setSku] = useState(""); const [suggestions, setSuggestions] = useState<SkuSuggestion[]>([]); const [selected, setSelected] = useState<SkuSuggestion | null>(null);
  const [qty, setQty] = useState("1"); const [name, setName] = useState(""); const [manualBrand, setManualBrand] = useState(""); const [image, setImage] = useState(""); const [size, setSize] = useState(""); const [feature, setFeature] = useState(""); const [category, setCategory] = useState(""); const [saving, setSaving] = useState(false);
  const [price, setPrice] = useState(""); const [variants, setVariants] = useState<{ label: string; price: string }[]>([]);
  const [newLot, setNewLot] = useState<GodownLot | null>(null);
  const [poFinalMatches, setPoFinalMatches] = useState<PoFinalMatch[]>([]);
  const [transferLot, setTransferLot] = useState<GodownLot | null>(null);
  const [transferMatch, setTransferMatch] = useState<PoFinalMatch | null>(null);
  const stockRequest = useRef(0);
  const dataFloor = useRef<string | null>(null);
  const currentFloor = useRef(selectedFloorId);
  const mounted = useRef(false);
  currentFloor.current = selectedFloorId;
  const isCurrentFloor = useCallback(() => mounted.current && currentFloor.current === selectedFloorId, [selectedFloorId]);
  const load = useCallback(async () => {
    // Mutation callbacks can outlive the floor that created them. Reject them
    // before they increment the request counter or start an old-floor reload.
    if (!selectedFloorId || !isCurrentFloor()) return;
    const request = ++stockRequest.current;
    const isCurrentRequest = () => isCurrentFloor() && request === stockRequest.current;
    setLoading(true); setError(null);
    try {
      const result = await getGodownStock("?include_history=true", selectedFloorId);
      if (isCurrentRequest()) { dataFloor.current = selectedFloorId; setData(result); }
    } catch (e: any) {
      if (isCurrentRequest()) setError(e?.detail || "Could not load godown stock");
    } finally { if (isCurrentRequest()) setLoading(false); }
  }, [selectedFloorId, isCurrentFloor]);
  useEffect(() => {
    mounted.current = true;
    dataFloor.current = null;
    setData(null); setBrand(null); setSelected(null); setSku("");
    setAdding(false); setSaving(false); checkedStockId.current = null;
    setNewLot(null); setTransferLot(null); setTransferMatch(null); setPoFinalMatches([]);
    void load();
    return () => { mounted.current = false; stockRequest.current += 1; };
  }, [load]);
  useEffect(() => {
    if (!newStockId || !data || dataFloor.current !== selectedFloorId || checkedStockId.current === newStockId) return;
    const lot = data.lots.find(row => row.id === newStockId);
    if (!lot) return;
    let live = true;
    void getPoFinalMatches(newStockId).then(result => {
      if (!live || !isCurrentFloor()) return;
      checkedStockId.current = newStockId;
      if (result.matches.length) { setNewLot(lot); setPoFinalMatches(result.matches); }
    }).catch((matchError: any) => { if (live && isCurrentFloor()) toast.error(matchError?.detail || "PO Final matches could not be checked"); });
    return () => { live = false; };
  }, [newStockId, data, selectedFloorId, isCurrentFloor]);
  useEffect(() => {
    if (mode !== "catalog" || !sku.trim() || selected?.sku === sku) { setSuggestions([]); return; }
    let live = true;
    const timer = setTimeout(() => { void getSkuSuggestions(sku.trim()).then(rows => { if (live) setSuggestions(rows); }).catch(() => { if (live) setSuggestions([]); }); }, 180);
    return () => { live = false; clearTimeout(timer); };
  }, [sku, mode, selected, selectedFloorId]);
  const save = async () => {
    const amount = Number(qty);
    if (!Number.isFinite(amount) || amount <= 0 || (mode === "catalog" && !selected) || (mode === "manual" && (!sku.trim() || !name.trim()))) { toast.error("Select a product or enter its SKU and name, then a positive quantity"); return; }
    if (mode === "manual" && (price.trim() === "" || !Number.isFinite(Number(price)) || Number(price) < 0 || variants.some(v => !v.label.trim() || v.price.trim() === "" || !Number.isFinite(Number(v.price)) || Number(v.price) < 0))) { toast.error("Enter a valid price and label/price for every variant"); return; }
    setSaving(true);
    try {
      const created = await addDirectGodownStock(mode === "catalog" ? { product_id: selected!.id, qty: amount } : { sku: sku.trim(), name: name.trim(), brand: manualBrand.trim(), image: image.trim(), size: size.trim(), feature: feature.trim(), category: category.trim(), qty: amount, unit_price: Number(price), price_variants: variants.map(v => ({ label: v.label.trim(), price: Number(v.price) })) });
      if (!isCurrentFloor()) return;
      toast.success("Product added to godown stock"); setAdding(false); setSku(""); setSelected(null); setQty("1"); setName(""); setManualBrand(""); setImage(""); setSize(""); setFeature(""); setCategory(""); setPrice(""); setVariants([]); await load();
      if (!isCurrentFloor()) return;
      try {
        const result = await getPoFinalMatches(created.id);
        if (!isCurrentFloor()) return;
        if (result.matches.length) { setNewLot(created); setPoFinalMatches(result.matches); }
      } catch (matchError: any) { if (isCurrentFloor()) toast.error(matchError?.detail || "Stock added, but PO Final matches could not be checked"); }
    } catch (e: any) { if (isCurrentFloor()) toast.error(e?.detail || "Could not add stock"); } finally { if (isCurrentFloor()) setSaving(false); }
  };
  const lots = useMemo(() => (data?.lots || []).filter(lot => (!brand || (lot.brand_id || lot.brand_name) === brand) && `${lot.name} ${lot.sku} ${lot.brand_name || ""}`.toLowerCase().includes(q.trim().toLowerCase())), [data, brand, q]);
  const exportStock = async (section: "inventory" | "movements") => {
    try {
      const rows = section === "inventory"
        ? [["SKU", "Product", "Brand", "Received", "Available", "Transferable", "Unit price (INR)", "Stock value (INR)"], ...lots.map(lot => [lot.sku, lot.name, lot.brand_name, lot.qty_received, lot.available_qty, lot.transferable_qty ?? lot.available_qty, lot.unit_price, lot.stock_value])]
        : [["SKU", "Product", "Event", "Customer / quotation", "Quantity", "Date"], ...lots.flatMap(lot => [
          ...(lot.allocations || []).map(row => [lot.sku, lot.name, "Allocated", row.customer_name || row.quotation_number || row.quotation_id, row.qty, row.allocated_at]),
          ...(lot.customer_transfers || []).map(row => [lot.sku, lot.name, "Transferred", row.recipient_customer_name, row.qty, row.created_at]),
        ])];
      await downloadSectionExcel({ resource: "godown_stock", page: "Godown stock", section: section === "inventory" ? "Available inventory" : "Stock movements", rows, filename: `godown-${section}.xlsx`, floorId: selectedFloorId });
    } catch (exportError: any) { toast.error(exportError?.message || "Could not export godown stock"); }
  };
  if (loading) return <View style={styles.center}><ActivityIndicator /><Text style={type.bodyMuted}>Loading stock…</Text></View>;
  if (error) return <ErrorState title="Godown stock unavailable" subtitle={error} onRetry={() => void load()} />;
  return <ScrollView contentContainerStyle={[styles.page, isPhone && styles.pagePhone]} keyboardShouldPersistTaps="handled">
    <View style={[styles.hero, isPhone && styles.heroPhone]}><View style={{ flex: 1, gap: 5 }}><Text style={type.overline}>INVENTORY</Text><Text style={type.displayMd}>Godown stock</Text><Text style={type.bodyMuted}>Stock history stays visible at zero quantity. Available units can be reused in a quotation.</Text></View><View style={[styles.actions, isPhone && styles.totalsPhone]}><View accessibilityLabel={`${money(data?.total_stock_value || 0)} priced stock value`} style={[styles.total, isPhone && styles.totalPhone]}><Text style={styles.totalNumber} numberOfLines={1} adjustsFontSizeToFit>{money(data?.total_stock_value || 0)}</Text><Text style={styles.totalLabel}>{data?.unpriced_lot_count ? `priced value · ${data.unpriced_lot_count} unpriced lot${data.unpriced_lot_count === 1 ? "" : "s"}` : "total available value"}</Text></View><View accessibilityLabel={`${data?.total_available_qty || 0} units available`} style={[styles.total, isPhone && styles.totalPhone]}><Text style={styles.totalNumber}>{data?.total_available_qty || 0}</Text><Text style={styles.totalLabel}>units available</Text></View></View></View>
    <Pressable accessibilityRole="button" onPress={() => setAdding(!adding)} style={styles.add}><Feather name={adding ? "x" : "plus"} size={17} color={colors.onBrand} /><Text style={styles.addText}>{adding ? "Close" : "Add product to godown"}</Text></Pressable>
    {adding ? <View style={styles.form}>
      <View style={styles.actions}><Chip label="From catalog" selected={mode === "catalog"} onPress={() => { setMode("catalog"); setSku(""); setSelected(null); }} /><Chip label="Product not in catalog" selected={mode === "manual"} onPress={() => { setMode("manual"); setSku(""); setSelected(null); }} /></View>
      <TextInput accessibilityLabel="SKU code" value={sku} onChangeText={value => { setSku(value); setSelected(null); }} placeholder="Type SKU code" style={styles.search} />
      {mode === "catalog" ? <View>{suggestions.map(row => <Pressable key={row.id} accessibilityRole="button" onPress={() => { setSelected(row); setSku(row.sku); setSuggestions([]); }} style={styles.suggestion}><Text style={type.body}>{row.sku} · {row.name}</Text><Text style={type.caption}>{row.brand_name || ""}</Text></Pressable>)}{selected ? <Text style={type.body}>Selected: {selected.name}</Text> : null}</View> : <View style={styles.manualFields}>
        {([ ["Product name", name, setName], ["Brand", manualBrand, setManualBrand], ["Image URL", image, setImage], ["Size", size, setSize], ["Feature", feature, setFeature], ["Category", category, setCategory] ] as const).map(([label, value, setter]) => <TextInput key={label} accessibilityLabel={label} placeholder={label} value={value} onChangeText={setter} style={styles.search} />)}
      </View>}
      {mode === "manual" ? <View style={styles.manualFields}>
        <TextInput accessibilityLabel="Unit price" value={price} onChangeText={setPrice} keyboardType="decimal-pad" placeholder="Unit price (₹)" style={styles.search} />
        <Text style={type.bodyMuted}>Optional price variants for this stock</Text>
        {variants.map((variant, index) => <View key={index} style={styles.actions}><TextInput accessibilityLabel={`Variant ${index + 1} label`} value={variant.label} onChangeText={label => setVariants(rows => rows.map((row, i) => i === index ? { ...row, label } : row))} placeholder="Variant name" style={[styles.search, { flex: 1 }]} /><TextInput accessibilityLabel={`Variant ${index + 1} price`} value={variant.price} onChangeText={variantPrice => setVariants(rows => rows.map((row, i) => i === index ? { ...row, price: variantPrice } : row))} keyboardType="decimal-pad" placeholder="Price (₹)" style={[styles.search, { flex: 1 }]} /><Pressable accessibilityRole="button" accessibilityLabel={`Remove variant ${index + 1}`} onPress={() => setVariants(rows => rows.filter((_, i) => i !== index))} style={styles.details}><Feather name="x" size={16} color={colors.brand} /></Pressable></View>)}
        <Pressable accessibilityRole="button" onPress={() => setVariants(rows => [...rows, { label: "", price: "" }])} style={styles.details}><Text style={styles.detailsText}>Add price variant</Text></Pressable>
      </View> : null}
      <TextInput accessibilityLabel="Quantity to add" value={qty} onChangeText={setQty} keyboardType="decimal-pad" placeholder="Quantity" style={styles.search} />
      <Pressable accessibilityRole="button" disabled={saving} onPress={() => void save()} style={[styles.add, saving && { opacity: .5 }]}><Text style={styles.addText}>{saving ? "Adding…" : "Add to godown stock"}</Text></Pressable>
    </View> : null}
    <TextInput accessibilityLabel="Search godown stock" value={q} onChangeText={setQ} placeholder="Search brand, SKU or product" style={styles.search} />
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="tablist"><Chip label="All brands" selected={!brand} onPress={() => setBrand(null)} />{data?.brands.map(row => <Chip key={row.id || row.name} label={`${row.name} · ${row.available_qty}`} selected={brand === (row.id || row.name)} onPress={() => setBrand(row.id || row.name)} />)}</ScrollView>
    <Text accessibilityLiveRegion="polite" style={styles.result}>{lots.filter(lot => lot.available_qty > 0).length} available · {lots.filter(lot => lot.available_qty <= 0).length} zero-stock lots</Text>
    <View style={styles.exportActions}><Pressable accessibilityRole="button" accessibilityLabel="Export filtered godown inventory to Excel" testID="godown-export-inventory" disabled={!lots.length} onPress={() => void exportStock("inventory")} style={[styles.exportButton, !lots.length && { opacity: .45 }]}><Feather name="download" size={15} color={colors.brand} /><Text style={styles.detailsText}>Inventory .xlsx</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Export godown stock movements to Excel" testID="godown-export-movements" disabled={!lots.some(lot => (lot.allocations?.length || 0) + (lot.customer_transfers?.length || 0) > 0)} onPress={() => void exportStock("movements")} style={[styles.exportButton, !lots.some(lot => (lot.allocations?.length || 0) + (lot.customer_transfers?.length || 0) > 0) && { opacity: .45 }]}><Feather name="download" size={15} color={colors.brand} /><Text style={styles.detailsText}>Movements .xlsx</Text></Pressable></View>
    <View style={[styles.grid, !isPhone && styles.gridWide]}>{lots.map(lot => <LotCard key={lot.id} lot={lot} compact={isPhone} width={isPhone ? "100%" : isDesktop ? "31.9%" : "48.8%"} canEditPricing={canEditPricing} onUpdated={() => void load()} onViewDetails={() => { if (lot.product_id) router.push(`/(admin)/catalog/${encodeURIComponent(lot.product_id)}` as any); }} onAdd={(variantIndex) => router.push(`/(admin)/quotations/new?godownStockId=${encodeURIComponent(lot.id)}${variantIndex === null ? "" : `&godownVariant=${variantIndex}`}` as any)} onTransfer={() => { setTransferMatch(null); setTransferLot(lot); }} />)}</View>
    {!lots.length ? <View style={styles.empty}><Feather name="archive" size={28} color={colors.onSurfaceMuted} /><Text style={type.titleMd}>No matching stock</Text><Text style={type.bodyMuted}>Try another brand or search term.</Text></View> : null}
    <Sheet open={!!newLot && poFinalMatches.length > 0} onClose={() => { setNewLot(null); setPoFinalMatches([]); }} title="Matching orders in PO Final" width={560}>
      <View style={{ gap: spacing.md, paddingBottom: spacing.md }}>
        <Text style={type.body}>You ordered this many quantities of this product. You can transfer this many quantities to the customers whose products are still in your PO final stage.</Text>
        <Text style={type.caption}>{newLot?.name} · {newLot?.sku} · {newLot?.available_qty} in GoDown Stock · {newLot?.transferable_qty ?? newLot?.available_qty} available to transfer</Text>
        {poFinalMatches.map(match => <View key={match.purchase_item_id} style={[styles.matchRow, isPhone && { flexDirection: "column", alignItems: "stretch" }]}>
          <View style={{ flex: 1, gap: 3 }}><Text style={type.titleMd}>{match.customer_name}</Text><Text style={type.caption}>{match.name} · ordered {match.ordered_qty} · waiting {match.remaining_qty}</Text><Text style={type.caption}>Can transfer up to {Math.min(newLot?.transferable_qty ?? newLot?.available_qty ?? 0, match.remaining_qty)} now</Text></View>
          <Pressable accessibilityRole="button" accessibilityLabel={`Transfer stock to ${match.customer_name}`} disabled={!(newLot?.transferable_qty ?? newLot?.available_qty) || !match.remaining_qty} onPress={() => { setTransferLot(newLot); setTransferMatch(match); setNewLot(null); setPoFinalMatches([]); }} style={[styles.details, { flex: 0 }, (!(newLot?.transferable_qty ?? newLot?.available_qty) || !match.remaining_qty) && { opacity: .45 }]}><Text style={styles.detailsText}>Transfer</Text></Pressable>
        </View>)}
        <Pressable accessibilityRole="button" onPress={() => { setNewLot(null); setPoFinalMatches([]); }} style={styles.details}><Text style={styles.detailsText}>Later</Text></Pressable>
      </View>
    </Sheet>
    <CustomerTransferSheet lot={transferLot} initialMatch={transferMatch} onClose={() => { setTransferLot(null); setTransferMatch(null); }} onTransferred={load} />
  </ScrollView>;
}
function Chip({ label, selected, onPress }: { label: string; selected: boolean; onPress: () => void }) { return <Pressable accessibilityRole="tab" accessibilityState={{ selected }} onPress={onPress} style={[styles.chip, selected && styles.chipSelected]}><Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text></Pressable>; }
function LotCard({ lot, width, compact, canEditPricing, onUpdated, onViewDetails, onAdd, onTransfer }: { lot: GodownLot; width: DimensionValue; compact: boolean; canEditPricing: boolean; onUpdated: () => void; onViewDetails: () => void; onAdd: (variantIndex: number | null) => void; onTransfer: () => void }) {
  const [variantIndex, setVariantIndex] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [editingPrice, setEditingPrice] = useState(false);
  const [draftPrice, setDraftPrice] = useState("");
  const [draftVariants, setDraftVariants] = useState<{ label: string; price: string }[]>([]);
  const [savingPrice, setSavingPrice] = useState(false);
  const variants = lot.price_variants || [];
  const selectedPrice = variantIndex === null ? (lot.unit_price || 0) : variants[variantIndex]?.price || 0;
  const isCatalogProduct = Boolean(lot.product_id && !lot.product_id.startsWith("godown:"));
  const savePricing = async () => {
    const amount = Number(draftPrice);
    if (!draftPrice.trim() || !Number.isFinite(amount) || amount < 0 || draftVariants.some(row => !row.label.trim() || !row.price.trim() || !Number.isFinite(Number(row.price)) || Number(row.price) < 0)) { toast.error("Enter a valid unit price and variant prices"); return; }
    setSavingPrice(true);
    try {
      await updateGodownPricing(lot.id, { unit_price: amount, price_variants: draftVariants.map(row => ({ label: row.label.trim(), price: Number(row.price) })) });
      toast.success("Stock pricing updated"); setEditingPrice(false); onUpdated();
    } catch (error: any) { toast.error(error?.detail || "Could not update stock pricing"); }
    finally { setSavingPrice(false); }
  };
  return <View style={[styles.card, { width }]}>
    <View style={styles.cardHead}><ProductImage source={lot.image || null} style={styles.image} fallbackLabel={lot.sku} accessibilityLabel={`${lot.name} product image`} /><View style={{ flex: 1, minWidth: 0, gap: 3 }}><Text style={styles.brand}>{lot.brand_name || "Unbranded"}</Text><Text style={type.titleMd} numberOfLines={2}>{lot.name}</Text><Text style={type.caption}>{lot.sku}{lot.finish ? ` · ${lot.finish}` : ""}{lot.size ? ` · ${lot.size}` : ""}</Text></View></View>
    <View style={styles.availability}><Feather name={lot.available_qty > 0 ? "check-circle" : "archive"} size={15} color={lot.available_qty > 0 ? colors.success : colors.onSurfaceMuted} /><Text style={styles.available}>{lot.available_qty > 0 ? `${lot.available_qty} in stock` : "Out of stock · 0 units"} · {lot.stock_value == null ? "Value not recorded" : `${money(lot.stock_value)} stock value`}</Text></View>
    <Text style={type.caption}>{lot.transferable_qty ?? lot.available_qty} available to transfer</Text>
    <Text style={type.body}>Unit price: {lot.unit_price == null ? "Not recorded" : money(lot.unit_price)}</Text>
    {canEditPricing ? <Pressable accessibilityRole="button" accessibilityLabel={`Edit pricing for ${lot.name}`} onPress={() => { setDraftPrice(lot.unit_price == null ? "" : String(lot.unit_price)); setDraftVariants((lot.price_variants || []).map(row => ({ label: row.label, price: String(row.price) }))); setEditingPrice(!editingPrice); }}><Text style={styles.detailsText}>{editingPrice ? "Cancel price edit" : "Edit pricing"}</Text></Pressable> : null}
    {editingPrice ? <View style={styles.manualFields}>
      <TextInput accessibilityLabel={`Unit price for ${lot.name}`} value={draftPrice} onChangeText={setDraftPrice} keyboardType="decimal-pad" placeholder="Unit price (₹)" style={styles.search} />
      {draftVariants.map((row, index) => <View key={index} style={styles.actions}><TextInput accessibilityLabel={`Price variant ${index + 1} label`} value={row.label} onChangeText={label => setDraftVariants(rows => rows.map((item, i) => i === index ? { ...item, label } : item))} placeholder="Variant name" style={[styles.search, { flex: 1 }]} /><TextInput accessibilityLabel={`Price variant ${index + 1} price`} value={row.price} onChangeText={variantPrice => setDraftVariants(rows => rows.map((item, i) => i === index ? { ...item, price: variantPrice } : item))} keyboardType="decimal-pad" placeholder="Price (₹)" style={[styles.search, { flex: 1 }]} /><Pressable accessibilityRole="button" accessibilityLabel={`Remove price variant ${index + 1}`} onPress={() => setDraftVariants(rows => rows.filter((_, i) => i !== index))} style={styles.details}><Feather name="x" size={16} color={colors.brand} /></Pressable></View>)}
      <View style={styles.actions}><Pressable accessibilityRole="button" disabled={draftVariants.length >= 20} onPress={() => setDraftVariants(rows => [...rows, { label: "", price: "" }])} style={styles.details}><Text style={styles.detailsText}>Add variant</Text></Pressable><Pressable accessibilityRole="button" disabled={savingPrice} onPress={() => void savePricing()} style={styles.add}><Text style={styles.addText}>{savingPrice ? "Saving…" : "Save pricing"}</Text></Pressable></View>
    </View> : null}
    {variants.length ? <View style={styles.chips}><Chip label={`Base · ${money(lot.unit_price || 0)}`} selected={variantIndex === null} onPress={() => setVariantIndex(null)} />{variants.map((variant, index) => <Chip key={`${variant.label}-${index}`} label={`${variant.label} · ${money(variant.price)}`} selected={variantIndex === index} onPress={() => setVariantIndex(index)} />)}</View> : null}
    <Text style={type.caption}>Arrival: {fmt(lot.transferred_at || lot.created_at)}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${showHistory ? "Hide" : "Show"} stock history for ${lot.name}`} onPress={() => setShowHistory(!showHistory)}><Text style={styles.detailsText}>{showHistory ? "Hide" : "Show"} stock history</Text></Pressable>
    {showHistory ? <View style={styles.provenance}>
      <Text style={styles.provenanceTitle}>Source</Text><Text style={type.bodyMuted}>{lot.source_customer_name ? `Original purchase for ${lot.source_customer_name}` : lot.source_type === "manual" ? "Added as a product outside the catalog" : "Added directly from the catalog"}</Text>
      {lot.source_purchased_at ? <Text style={type.caption}>Purchased: {fmt(lot.source_purchased_at)}</Text> : null}
      {lot.source_purchase_order_id ? <Text style={type.caption}>Purchase order: {lot.source_purchase_order_id}</Text> : null}
      {lot.source_quotation_id ? <Text style={type.caption}>Source quotation: {lot.source_quotation_id}</Text> : null}
      <Text style={[styles.provenanceTitle, { marginTop: 8 }]}>Arrival in godown</Text><Text style={type.caption}>{fmt(lot.transferred_at)} · {lot.reason || "Stock intake"}</Text>
      {lot.transferred_by_name ? <Text style={type.caption}>Recorded by {lot.transferred_by_name}</Text> : null}
      <Text style={[styles.provenanceTitle, { marginTop: 8 }]}>Stock cycle</Text><Text style={type.caption}>Received {lot.qty_received} · Allocated {lot.qty_received - lot.available_qty} · Available {lot.available_qty}</Text>
      {(lot.allocations || []).map(allocation => <Text key={allocation.id} style={type.caption}>{fmt(allocation.allocated_at)} · {allocation.qty} to {allocation.quotation_number || allocation.quotation_id || "quotation"}{allocation.customer_name ? ` for ${allocation.customer_name}` : ""}{allocation.allocated_by_name ? ` · ${allocation.allocated_by_name}` : ""}</Text>)}
      {(lot.customer_transfers || []).map((transfer) => <Text key={transfer.id} style={type.caption}>{fmt(transfer.created_at)} · {transfer.qty} transferred to {transfer.recipient_customer_name}{transfer.recipient_purchase_item_id ? " · PO Final moved to In Box" : ""}{transfer.discount_pct ? ` · ${transfer.discount_pct}% discount` : ""}</Text>)}
    </View> : null}
    <Pressable accessibilityRole="button" accessibilityLabel={`Transfer ${lot.name} to a customer`} disabled={(lot.transferable_qty ?? lot.available_qty) <= 0} onPress={onTransfer} style={[styles.details, (lot.transferable_qty ?? lot.available_qty) <= 0 && { opacity: .45 }]}><Feather name="repeat" size={16} color={colors.brand} /><Text style={styles.detailsText}>Transfer to customer</Text></Pressable>
    <View style={[styles.actions, compact && { flexDirection: "column" }]}><Pressable accessibilityRole="button" accessibilityLabel={`View catalog details for ${lot.name}`} disabled={!isCatalogProduct} onPress={onViewDetails} style={[styles.details, !isCatalogProduct && { opacity: .45 }]}><Feather name="external-link" size={16} color={colors.brand} /><Text style={styles.detailsText}>View details</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Add ${lot.name} at ${money(selectedPrice)} to a new quotation`} disabled={(lot.transferable_qty ?? lot.available_qty) <= 0} onPress={() => onAdd(variantIndex)} style={[styles.add, (lot.transferable_qty ?? lot.available_qty) <= 0 && { opacity: .45 }]}><Feather name="plus" size={17} color={colors.onBrand} /><Text style={styles.addText}>Add to quotation</Text></Pressable></View>
  </View>;
}
const styles = StyleSheet.create({ matchRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary }, form: { padding: spacing.lg, gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary }, manualFields: { gap: spacing.sm }, suggestion: { padding: spacing.sm, borderBottomWidth: 1, borderColor: colors.border }, page: { padding: spacing.xl, gap: spacing.lg, maxWidth: 1320, width: "100%", alignSelf: "center" }, pagePhone: { padding: spacing.md }, totalsPhone: { flexWrap: "wrap" }, totalPhone: { minWidth: 0, flexGrow: 1, flexBasis: 125, padding: spacing.md }, exportActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }, exportButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.brandBorder, borderRadius: radius.md, backgroundColor: colors.brandTint }, center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }, hero: { flexDirection: "row", gap: spacing.xl, padding: spacing.xl, borderRadius: radius.lg, backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, heroPhone: { flexDirection: "column" }, total: { minWidth: 128, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.brandTint, justifyContent: "center" }, totalNumber: { fontSize: 30, fontWeight: "800", color: colors.brand }, totalLabel: { fontSize: 12, color: colors.onSurfaceSecondary }, search: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, backgroundColor: colors.surfaceSecondary, color: colors.onSurface }, chips: { gap: 8, paddingRight: 16 }, chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.surfaceTertiary }, chipSelected: { backgroundColor: colors.brand }, chipText: { fontWeight: "600", color: colors.onSurfaceSecondary }, chipTextSelected: { color: colors.onBrand }, result: { ...type.caption, color: colors.onSurfaceMuted }, grid: { gap: spacing.md }, gridWide: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch" }, card: { maxWidth: 420, minWidth: 0, padding: spacing.lg, gap: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, cardHead: { flexDirection: "row", gap: 12 }, image: { width: 74, height: 74, borderRadius: radius.sm, backgroundColor: colors.surfaceTertiary }, brand: { ...type.overline, color: colors.brand }, availability: { flexDirection: "row", alignItems: "center", gap: 6 }, available: { fontWeight: "700", color: colors.success }, provenance: { paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, provenanceTitle: { fontSize: 11, fontWeight: "700", color: colors.onSurfaceSecondary, textTransform: "uppercase", letterSpacing: .5 }, actions: { flexDirection: "row", gap: spacing.sm }, details: { minHeight: 48, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.brandBorder, backgroundColor: colors.brandTint, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", flex: 1 }, detailsText: { fontWeight: "700", color: colors.brand }, add: { minHeight: 48, borderRadius: radius.md, backgroundColor: colors.brand, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", flex: 1.25 }, addText: { fontWeight: "700", color: colors.onBrand }, empty: { alignItems: "center", padding: 48, gap: 8 } });
