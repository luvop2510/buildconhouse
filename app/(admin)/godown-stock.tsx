import { MobileFilterSection } from "@/src/components/MobileFilterSection";
import { filterValues, matchesFilter, toggleFilterValue } from "@/src/utils/filters";
import * as ImagePicker from "expo-image-picker";
import { randomUUID } from "expo-crypto";
import type { UploadImage } from "@/src/utils/appendImageUpload";
import Feather from "@expo/vector-icons/Feather";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View, type DimensionValue } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { addDirectGodownStock, getGodownHistory, getGodownLot, getGodownStock, getPoFinalMatches, getSkuSuggestions, recordGodownQuantity, updateGodownDetails, uploadGodownImage, type GodownHistory, type GodownLot, type GodownStockResponse, type PoFinalMatch, type SkuSuggestion } from "@/src/api/godownStock";
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
const stockPhotoMessages = { missing: "Photo needed", loading: "Loading photo", failed: "Photo unavailable" };
const stockQuery = (q: string, brand: string | null, offset = 0) => `?include_history=true&with_movements=false&limit=60&offset=${offset}&q=${encodeURIComponent(q.trim())}&brands=${encodeURIComponent(brand || "")}`;
const queryIdentity = (floor: string | null, q: string, brand: string | null) => JSON.stringify([floor, q.trim(), brand || ""]);
function mergeStockUpdate(current: GodownStockResponse | null, update: GodownLot) {
  if (!current) return current;
  const before = current.lots.find(row => row.id === update.id);
  if (!before) return current;
  const after = { ...before, ...update };
  const qty = (row: GodownLot) => row.quantity_missing ? 0 : row.available_qty;
  const value = (row: GodownLot) => row.stock_value ?? (row.unit_price == null ? 0 : qty(row) * row.unit_price);
  const unpriced = (row: GodownLot) => Number(row.unit_price == null && (row.available_qty > 0 || row.quantity_missing));
  const brandKey = (row: GodownLot) => row.brand_id || row.brand_name || "unbranded";
  return { ...current, lots: current.lots.map(row => row.id === update.id ? after : row),
    total_available_qty: current.total_available_qty + qty(after) - qty(before),
    total_stock_value: Math.round((current.total_stock_value + value(after) - value(before)) * 100) / 100,
    unpriced_lot_count: current.unpriced_lot_count + unpriced(after) - unpriced(before),
    brands: current.brands.map(brand => ({ ...brand, available_qty: brand.available_qty + ((brand.id || brand.name) === brandKey(after) ? qty(after) : 0) - ((brand.id || brand.name) === brandKey(before) ? qty(before) : 0) })),
    ...(current.total_lots === undefined ? {} : {
      available_lot_count: (current.available_lot_count || 0) + Number(qty(after) > 0) - Number(qty(before) > 0),
      unknown_quantity_count: (current.unknown_quantity_count || 0) + Number(!!after.quantity_missing) - Number(!!before.quantity_missing),
      zero_lot_count: (current.zero_lot_count || 0) + Number(!after.quantity_missing && qty(after) <= 0) - Number(!before.quantity_missing && qty(before) <= 0),
    }),
  };
}

export default function GodownStockScreen() {
  const { selectedFloorId } = useFloorAccess();
  const { staff } = useAuth();
  const canEditPricing = useActionAccess("godown_stock", "update", staff?.role !== "worker");
  const router = useRouter(); const { isPhone, isDesktop } = useBp();
  const { newStockId } = useLocalSearchParams<{ newStockId?: string }>();
  const newStockContext = useRef({ id: newStockId, floor: selectedFloorId });
  if (newStockContext.current.id !== newStockId || !newStockContext.current.floor) newStockContext.current = { id: newStockId, floor: selectedFloorId };
  const checkedStockId = useRef<string | null>(null);
  const [data, setData] = useState<GodownStockResponse | null>(null); const [q, setQ] = useState(""); const [brand, setBrand] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false); const [mode, setMode] = useState<"catalog" | "manual">("catalog");
  const [sku, setSku] = useState(""); const [suggestions, setSuggestions] = useState<SkuSuggestion[]>([]); const [selected, setSelected] = useState<SkuSuggestion | null>(null);
  const [qty, setQty] = useState(""); const [name, setName] = useState(""); const [manualBrand, setManualBrand] = useState(""); const [image, setImage] = useState(""); const [size, setSize] = useState(""); const [feature, setFeature] = useState(""); const [category, setCategory] = useState(""); const [saving, setSaving] = useState(false);
  const [price, setPrice] = useState(""); const [variants, setVariants] = useState<{ label: string; price: string }[]>([]);
  const intakeCommand = useRef<{ fingerprint: string; key: string; pending: boolean } | null>(null);
  const [newLot, setNewLot] = useState<GodownLot | null>(null);
  const [poFinalMatches, setPoFinalMatches] = useState<PoFinalMatch[]>([]);
  const [transferLot, setTransferLot] = useState<GodownLot | null>(null);
  const [visibleCount, setVisibleCount] = useState(60);
  useEffect(() => { setVisibleCount(60); }, [q, brand, selectedFloorId]);
  const [transferMatch, setTransferMatch] = useState<PoFinalMatch | null>(null);
  const stockRequest = useRef(0);
  const dataFloor = useRef<string | null>(null);
  const currentFloor = useRef(selectedFloorId);
  const mounted = useRef(false);
  const filters = useRef({ q, brand }); filters.current = { q, brand };
  const requestedQuery = useRef("");
  const dataQuery = useRef("");
  const dataRef = useRef(data); dataRef.current = data;
  const pageRequest = useRef<object | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pageError, setPageError] = useState("");
  currentFloor.current = selectedFloorId;
  const isCurrentFloor = useCallback(() => mounted.current && currentFloor.current === selectedFloorId, [selectedFloorId]);
  const load = useCallback(async (criteria = filters.current) => {
    // Mutation callbacks can outlive the floor that created them. Reject them
    // before they increment the request counter or start an old-floor reload.
    if (!selectedFloorId || !isCurrentFloor()) return;
    const request = ++stockRequest.current;
    const identity = queryIdentity(selectedFloorId, criteria.q, criteria.brand);
    const pages = requestedQuery.current === identity && dataRef.current?.total_lots !== undefined ? Math.max(1, Math.ceil(dataRef.current.lots.length / 60)) : 1;
    requestedQuery.current = identity;
    pageRequest.current = null; setLoadingMore(false); setPageError("");
    const isCurrentRequest = () => isCurrentFloor() && request === stockRequest.current;
    setLoading(true); setError(null);
    try {
      const result = await getGodownStock(stockQuery(criteria.q, criteria.brand), selectedFloorId);
      const rows = [...result.lots];
      // Refresh the already-open window without unmounting its lot editors.
      // Limit concurrent page reads rather than starting one request per card.
      if (result.total_lots !== undefined) for (let page = 1; page < pages && page * 60 < result.total_lots; page += 3) {
        if (!isCurrentRequest()) return;
        const next = await Promise.all(Array.from({ length: Math.min(3, pages - page, Math.ceil(result.total_lots / 60) - page) }, (_, i) => getGodownStock(stockQuery(criteria.q, criteria.brand, (page + i) * 60), selectedFloorId)));
        next.forEach(value => rows.push(...value.lots));
        result.next_offset = next[next.length - 1].next_offset;
      }
      if (isCurrentRequest()) { dataFloor.current = selectedFloorId; dataQuery.current = identity; setData({ ...result, lots: rows }); }
    } catch (e: any) {
      if (isCurrentRequest()) setError(e?.detail || "Could not load godown stock");
    } finally { if (isCurrentRequest()) setLoading(false); }
  }, [selectedFloorId, isCurrentFloor]);
  useEffect(() => {
    mounted.current = true;
    dataFloor.current = null;
    setData(null); setBrand(null); setSelected(null); setSku("");
    setAdding(false); setSaving(false); checkedStockId.current = null;
    intakeCommand.current = null;
    setNewLot(null); setTransferLot(null); setTransferMatch(null); setPoFinalMatches([]);
    void load({ q: filters.current.q, brand: null });
    return () => { mounted.current = false; stockRequest.current += 1; };
  }, [load]);
  useEffect(() => {
    if (queryIdentity(selectedFloorId, q, brand) === requestedQuery.current) return;
    const timer = setTimeout(() => { void load(); }, 180);
    return () => clearTimeout(timer);
  }, [q, brand, selectedFloorId, load]);
  const loadMore = async () => {
    if (!selectedFloorId || !isCurrentFloor()) return;
    const current = dataRef.current;
    if (current?.total_lots === undefined) { setVisibleCount(count => count + 60); return; }
    const identity = queryIdentity(selectedFloorId, filters.current.q, filters.current.brand);
    if (!isCurrentFloor() || pageRequest.current || loading || current.next_offset == null || dataQuery.current !== identity) return;
    const token = {}; pageRequest.current = token; setLoadingMore(true); setPageError("");
    const generation = stockRequest.current;
    try {
      const next = await getGodownStock(stockQuery(filters.current.q, filters.current.brand, current.next_offset), selectedFloorId || undefined);
      if (!isCurrentFloor() || generation !== stockRequest.current || identity !== queryIdentity(currentFloor.current, filters.current.q, filters.current.brand)) return;
      setData(value => value ? { ...next, lots: [...value.lots, ...next.lots.filter(row => !value.lots.some(old => old.id === row.id))] } : value);
      setVisibleCount(count => count + 60);
    } catch (e: any) { if (isCurrentFloor() && generation === stockRequest.current) setPageError(e?.detail || "Could not load more stock. Try again."); }
    finally { if (pageRequest.current === token) { pageRequest.current = null; setLoadingMore(false); } }
  };
  useEffect(() => {
    if (!newStockId || !data || dataFloor.current !== selectedFloorId || newStockContext.current.floor !== selectedFloorId || checkedStockId.current === newStockId) return;
    let live = true;
    void Promise.all([Promise.resolve(data.lots.find(row => row.id === newStockId) || null).then(lot => lot || getGodownLot(newStockId, undefined, selectedFloorId || undefined)), getPoFinalMatches(newStockId)]).then(([lot, result]) => {
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
    if (!selectedFloorId || !isCurrentFloor() || intakeCommand.current?.pending) return;
    const body = mode === "catalog" ? { product_id: selected!.id, qty: amount } : { sku: sku.trim(), name: name.trim(), brand: manualBrand.trim(), image: image.trim(), size: size.trim(), feature: feature.trim(), category: category.trim(), qty: amount, unit_price: Number(price), price_variants: variants.map(v => ({ label: v.label.trim(), price: Number(v.price) })) };
    const fingerprint = JSON.stringify([staff?.id, selectedFloorId, body]);
    if (intakeCommand.current?.fingerprint !== fingerprint) intakeCommand.current = { fingerprint, key: randomUUID(), pending: false };
    const command = intakeCommand.current;
    command.pending = true;
    setSaving(true);
    try {
      const created = await addDirectGodownStock({ ...body, idempotency_key: command.key }, selectedFloorId);
      if (!isCurrentFloor() || intakeCommand.current !== command) return;
      intakeCommand.current = null;
      toast.success(created.idempotent ? "This stock intake was already recorded" : "Product added to godown stock"); setAdding(false); setSku(""); setSelected(null); setQty(""); setName(""); setManualBrand(""); setImage(""); setSize(""); setFeature(""); setCategory(""); setPrice(""); setVariants([]); await load();
      if (!isCurrentFloor()) return;
      try {
        const result = await getPoFinalMatches(created.id);
        if (!isCurrentFloor()) return;
        if (result.matches.length) { setNewLot(created); setPoFinalMatches(result.matches); }
      } catch (matchError: any) { if (isCurrentFloor()) toast.error(matchError?.detail || "Stock added, but PO Final matches could not be checked"); }
    } catch (e: any) { if (isCurrentFloor() && intakeCommand.current === command) toast.error(e?.detail || "Could not confirm stock intake. Retry the unchanged form to check the same intake."); } finally { command.pending = false; if (isCurrentFloor() && (intakeCommand.current === command || intakeCommand.current === null)) setSaving(false); }
  };
  const currentQuery = data?.total_lots === undefined || dataQuery.current === queryIdentity(selectedFloorId, q, brand);
  const lots = useMemo(() => !currentQuery ? [] : (data?.lots || []).filter(lot => !lot.archived && (data?.total_lots !== undefined || (matchesFilter(lot.brand_id || lot.brand_name, brand) && `${lot.name} ${lot.sku} ${lot.brand_name || ""}`.toLowerCase().includes(q.trim().toLowerCase())))), [data, brand, q, currentQuery]);
  const [exporting, setExporting] = useState(false);
  const exportingNow = useRef(false);
  const exportStock = async (section: "inventory" | "movements") => {
    if (exportingNow.current || !selectedFloorId) return;
    exportingNow.current = true; setExporting(true);
    const exportGeneration = stockRequest.current;
    try {
      const complete = await getGodownStock(`?include_history=true&with_movements=${section === "movements"}&q=${encodeURIComponent(q.trim())}&brands=${encodeURIComponent(brand || "")}`, selectedFloorId);
      if (!isCurrentFloor() || exportGeneration !== stockRequest.current) return;
      const exportLots = complete.lots;
      const rows = section === "inventory"
        ? [["SKU", "Product", "Brand", "Received / counted opening balance", "Available", "Transferable", "Unit price (INR)", "Stock value (INR)"], ...exportLots.map(lot => [lot.sku, lot.name, lot.brand_name, lot.quantity_missing ? "Not recorded" : lot.qty_received, lot.quantity_missing ? "Not recorded" : lot.available_qty, lot.quantity_missing ? "Not recorded" : lot.transferable_qty ?? lot.available_qty, lot.unit_price, lot.stock_value])]
        : [["SKU", "Product", "Event", "Customer / quotation", "Quantity", "Date"], ...exportLots.flatMap(lot => [
          ...(lot.allocations || []).map(row => [lot.sku, lot.name, "Allocated", row.customer_name || row.quotation_number || row.quotation_id, row.qty, row.allocated_at]),
          ...(lot.customer_transfers || []).map(row => [lot.sku, lot.name, "Transferred", row.recipient_customer_name, row.qty, row.created_at]),
        ])];
      await downloadSectionExcel({ resource: "godown_stock", page: "Godown stock", section: section === "inventory" ? "Available inventory" : "Stock movements", rows, filename: `godown-${section}.xlsx`, floorId: selectedFloorId });
    } catch (exportError: any) { if (isCurrentFloor()) toast.error(exportError?.detail || exportError?.message || "Could not export godown stock"); }
    finally { exportingNow.current = false; if (mounted.current) setExporting(false); }
  };
  // Same-floor refreshes must retain card editors and transfer drafts. Never
  // retain another floor's rows while its reset effect is still pending.
  const canExport = !exporting && currentQuery && (data?.total_lots ?? lots.length) > 0;
  const hasCurrentData = data !== null && dataFloor.current === selectedFloorId;
  if (!hasCurrentData && error) return <ErrorState title="Godown stock unavailable" subtitle={error} onRetry={() => void load()} />;
  if (!hasCurrentData) return <View style={styles.center}><ActivityIndicator /><Text style={type.bodyMuted}>Loading stock…</Text></View>;
  return <ScrollView contentContainerStyle={[styles.page, isPhone && styles.pagePhone]} keyboardShouldPersistTaps="handled">
    {loading || error ? <View testID="godown-refresh-status" style={{ gap: spacing.sm }}>
      <Text accessibilityLiveRegion="polite" style={type.bodyMuted}>{loading ? "Refreshing stock…" : "Stock refresh failed. Displayed quantities may be out of date."}</Text>
      {error && !loading ? <Pressable accessibilityRole="button" accessibilityLabel="Retry stock refresh" onPress={() => void load()} style={styles.details}><Text style={styles.detailsText}>Retry stock refresh</Text></Pressable> : null}
    </View> : null}
    <View style={[styles.hero, !isDesktop && styles.heroPhone]}><View style={{ flex: 1, gap: 5 }}><Text style={type.overline}>INVENTORY</Text><Text style={type.displayMd}>Godown stock</Text><Text style={type.bodyMuted}>Stock history stays visible at zero quantity. Available units can be reused in a quotation.</Text></View><View style={[styles.actions, !isDesktop && styles.totalsPhone]}><View accessibilityLabel={`${money(data?.total_stock_value || 0)} priced stock value`} style={[styles.total, !isDesktop && styles.totalPhone]}><Text style={styles.totalNumber} numberOfLines={1} adjustsFontSizeToFit>{money(data?.total_stock_value || 0)}</Text><Text style={styles.totalLabel}>{data?.unpriced_lot_count ? `priced value · ${data.unpriced_lot_count} unpriced lot${data.unpriced_lot_count === 1 ? "" : "s"}` : "total available value"}</Text></View><View accessibilityLabel={`${data?.total_available_qty || 0} units available`} style={[styles.total, !isDesktop && styles.totalPhone]}><Text style={styles.totalNumber}>{data?.total_available_qty || 0}</Text><Text style={styles.totalLabel}>units available</Text></View></View></View>
    <Pressable accessibilityRole="button" accessibilityLabel={adding ? "Close stock intake" : "Add product to godown"} onPress={() => setAdding(!adding)} style={styles.add}><Feather name={adding ? "x" : "plus"} size={17} color={colors.onBrand} /><Text style={styles.addText}>{adding ? "Close" : "Add product to godown"}</Text></Pressable>
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
    <MobileFilterSection testID="godown-stock-filters">
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips} accessibilityRole="tablist"><Chip label="All brands" selected={!brand} onPress={() => setBrand(null)} />{data?.brands.map(row => <Chip key={row.id || row.name} label={`${row.name} · ${row.available_qty}`} selected={filterValues(brand).includes(row.id || row.name)} onPress={() => setBrand(current => toggleFilterValue(current, row.id || row.name, ""))} />)}</ScrollView>
    </MobileFilterSection>
    <Text testID="godown-results" accessibilityLiveRegion="polite" style={styles.result}>{!currentQuery ? "Searching stock…" : `${data?.available_lot_count ?? lots.filter(lot => !lot.quantity_missing && lot.available_qty > 0).length} available · ${data?.zero_lot_count ?? lots.filter(lot => !lot.quantity_missing && lot.available_qty <= 0).length} zero-stock lots · ${data?.unknown_quantity_count ?? lots.filter(lot => lot.quantity_missing).length} quantities not recorded · showing ${Math.min(visibleCount, lots.length)} of ${data?.total_lots ?? lots.length}`}</Text>
    {exporting ? <Text accessibilityLiveRegion="polite" style={type.body}>Preparing the complete filtered export…</Text> : null}
    <View style={styles.exportActions}><Pressable accessibilityRole="button" accessibilityLabel="Export filtered godown inventory to Excel" testID="godown-export-inventory" disabled={!canExport} onPress={() => void exportStock("inventory")} style={[styles.exportButton, !canExport && { opacity: .45 }]}><Feather name="download" size={15} color={colors.brand} /><Text style={styles.detailsText}>Inventory .xlsx</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel="Export godown stock movements to Excel" testID="godown-export-movements" disabled={!canExport} onPress={() => void exportStock("movements")} style={[styles.exportButton, !canExport && { opacity: .45 }]}><Feather name="download" size={15} color={colors.brand} /><Text style={styles.detailsText}>Movements .xlsx</Text></Pressable></View>
    <View style={[styles.grid, !isPhone && styles.gridWide]}>{lots.slice(0, visibleCount).map(lot => <LotCard key={`${selectedFloorId}:${lot.id}`} floorId={selectedFloorId || undefined} lot={lot} compact={isPhone} width={isPhone ? "100%" : isDesktop ? "31.9%" : "48.8%"} canEditPricing={canEditPricing} onUpdated={updated => { if (!isCurrentFloor()) return; setData(current => mergeStockUpdate(current, updated)); }} onViewDetails={() => { if (lot.product_id) router.push(`/(admin)/catalog/${encodeURIComponent(lot.product_id)}` as any); }} onAdd={(variantIndex) => router.push(`/(admin)/quotations/new?godownStockId=${encodeURIComponent(lot.id)}${variantIndex === null ? "" : `&godownVariant=${variantIndex}`}` as any)} onTransfer={() => { setTransferMatch(null); setTransferLot(lot); }} />)}</View>
    {pageError ? <Text accessibilityRole="alert" style={type.body}>{pageError}</Text> : null}
    {currentQuery && (data?.next_offset != null || visibleCount < lots.length) ? <Pressable accessibilityRole="button" accessibilityLabel="Load more godown stock" testID="godown-load-more" disabled={loadingMore || loading} onPress={() => void loadMore()} style={styles.details}><Text style={styles.detailsText}>{loadingMore ? "Loading more stock…" : `Load more (${(data?.total_lots ?? lots.length) - Math.min(visibleCount, lots.length)} remaining)`}</Text></Pressable> : null}
    {!lots.length && !loading && currentQuery ? <View style={styles.empty}><Feather name="archive" size={28} color={colors.onSurfaceMuted} /><Text style={type.titleMd}>No matching stock</Text><Text style={type.bodyMuted}>Try another brand or search term.</Text></View> : null}
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
function LotCard({ lot, floorId, width, compact, canEditPricing, onUpdated, onViewDetails, onAdd, onTransfer }: { lot: GodownLot; floorId?: string; width: DimensionValue; compact: boolean; canEditPricing: boolean; onUpdated: (updated: GodownLot) => void; onViewDetails: () => void; onAdd: (variantIndex: number | null) => void; onTransfer: () => void }) {
  const [variantIndex, setVariantIndex] = useState<number | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [editingPrice, setEditingPrice] = useState(false);
  const [addAfterPricing, setAddAfterPricing] = useState(false);
  const priceInput = useRef<React.ElementRef<typeof TextInput> | null>(null);
  useEffect(() => { if (editingPrice && addAfterPricing) priceInput.current?.focus(); }, [editingPrice, addAfterPricing]);
  const [draftPrice, setDraftPrice] = useState("");
  const [draftVariants, setDraftVariants] = useState<{ label: string; price: string }[]>([]);
  const [savingPrice, setSavingPrice] = useState(false);
  const [draftImage, setDraftImage] = useState("");
  const [photo, setPhoto] = useState<UploadImage | null>(null);
  const [pickingPhoto, setPickingPhoto] = useState(false);
  const [counting, setCounting] = useState(false);
  const [countQty, setCountQty] = useState("");
  const [countDate, setCountDate] = useState("");
  const [countReason, setCountReason] = useState("");
  const [countError, setCountError] = useState("");
  const [savingCount, setSavingCount] = useState(false);
  const countCommand = useRef<{ fingerprint: string; key: string } | null>(null);
  const lifecycle = useRef<AbortController | null>(null);
  const committing = useRef(false);
  useEffect(() => { const controller = new AbortController(); lifecycle.current = controller; return () => { controller.abort(); }; }, [lot.id, floorId]);
  const [history, setHistory] = useState<GodownHistory | null>(null);
  const [historyError, setHistoryError] = useState("");
  const [loadingHistory, setLoadingHistory] = useState(false);
  const historyPending = useRef<object | null>(null);
  const historyGeneration = useRef(0);
  useEffect(() => {
    historyGeneration.current += 1; historyPending.current = null; setLoadingHistory(false); setHistoryError("");
    setHistory(lot.history_loaded === false ? null : { allocations: lot.allocations || [], customer_transfers: lot.customer_transfers || [], next_offset: null });
    return () => { historyGeneration.current += 1; };
  }, [lot.id, lot.updated_at, lot.history_loaded, lot.allocations, lot.customer_transfers, floorId]);
  const loadHistory = useCallback(async (offset = 0) => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || historyPending.current) return;
    const token = {}; historyPending.current = token;
    const generation = historyGeneration.current;
    setLoadingHistory(true); setHistoryError("");
    try {
      const result = await getGodownHistory(lot.id, offset, controller.signal, floorId);
      if (controller.signal.aborted || generation !== historyGeneration.current) return;
      setHistory(current => offset === 0 || !current ? result : { ...result, allocations: [...current.allocations, ...result.allocations], customer_transfers: [...current.customer_transfers, ...result.customer_transfers] });
    } catch (e: any) { if (!controller.signal.aborted && generation === historyGeneration.current) setHistoryError(e?.detail || e?.message || "Could not load stock movements"); }
    finally { if (historyPending.current === token) { historyPending.current = null; setLoadingHistory(false); } }
  }, [lot.id, floorId]);
  useEffect(() => { if (showHistory && !history && !historyError && lot.history_loaded === false) void loadHistory(); }, [showHistory, history, historyError, lot.history_loaded, loadHistory]);
  const variants = lot.price_variants || [];
  const selectedPrice = variantIndex === null ? lot.unit_price : variants[variantIndex]?.price;
  const canTransfer = !lot.quantity_missing && !lot.archived && (lot.transferable_qty ?? lot.available_qty) > 0;
  const canQuote = canTransfer && selectedPrice != null && Number.isFinite(selectedPrice) && selectedPrice >= 0;
  const needsPrice = canTransfer && !canQuote;
  const refreshCountLot = async () => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || committing.current) return;
    committing.current = true; setSavingCount(true);
    try {
      const current = await getGodownLot(lot.id, controller.signal, floorId);
      if (controller.signal.aborted) return;
      onUpdated(current); setCountError("Stock refreshed. Review the count against the current lot before saving again.");
    } catch (error: any) { if (!controller.signal.aborted) setCountError(error?.detail || error?.message || "Could not refresh this lot. Try again."); }
    finally { committing.current = false; if (!controller.signal.aborted) setSavingCount(false); }
  };
  const saveCount = async () => {
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted || committing.current) return;
    const amount = Number(countQty);
    if (!countQty.trim() || !Number.isFinite(amount) || amount < 0) { setCountError("Enter the counted quantity. Use 0 only when you confirmed there are no units."); return; }
    const date = new Date(`${countDate}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(countDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== countDate) { setCountError("Enter the count date as YYYY-MM-DD."); return; }
    if (countReason.trim().length < 3) { setCountError("Record where the count came from, such as a physical count or a confirmed stock sheet."); return; }
    const body = { qty: amount, counted_on: countDate, reason: countReason.trim(), expected_updated_at: lot.updated_at || null };
    const fingerprint = JSON.stringify(body);
    if (countCommand.current?.fingerprint !== fingerprint) countCommand.current = { fingerprint, key: randomUUID() };
    committing.current = true; setSavingCount(true); setCountError("");
    try {
      const updated = await recordGodownQuantity(lot.id, { ...body, idempotency_key: countCommand.current.key }, controller.signal, floorId);
      if (controller.signal.aborted) return;
      onUpdated(updated); setCounting(false); countCommand.current = null;
      toast.success(updated.idempotent ? "This quantity count was already recorded" : "Stock quantity recorded");
    } catch (error: any) { if (!controller.signal.aborted) setCountError(error?.detail || error?.message || "Count could not be confirmed. Retry the unchanged count to resolve the same request."); }
    finally { committing.current = false; if (!controller.signal.aborted) setSavingCount(false); }
  };
  const openEditor = (thenAdd = false) => {
    setDraftImage(lot.image || ""); setPhoto(null);
    setDraftPrice(lot.unit_price == null ? "" : String(lot.unit_price));
    setDraftVariants((lot.price_variants || []).map(row => ({ label: row.label, price: String(row.price) })));
    setAddAfterPricing(thenAdd); setEditingPrice(true);
  };
  const pickPhoto = async () => {
    const controller = lifecycle.current;
    if (pickingPhoto || savingPrice) return;
    setPickingPhoto(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], quality: 1, allowsEditing: false });
      if (controller?.signal.aborted || result.canceled || !result.assets?.[0]) return;
      // Retain the picker asset's original File for CSP-safe web multipart.
      setPhoto(result.assets[0]);
    } catch (error: any) { if (!controller?.signal.aborted) toast.error(error?.message || "Could not choose the stock photo"); }
    finally { if (!controller?.signal.aborted) setPickingPhoto(false); }
  };
  const isCatalogProduct = Boolean(lot.product_id && !lot.product_id.startsWith("godown:"));
  const savePricing = async () => {
    if (committing.current) return;
    const amount = draftPrice.trim() ? Number(draftPrice) : null;
    if ((amount !== null && (!Number.isFinite(amount) || amount < 0)) || draftVariants.some(row => !row.label.trim() || !row.price.trim() || !Number.isFinite(Number(row.price)) || Number(row.price) < 0)) { toast.error("Enter a valid price or leave it blank, and valid variant prices"); return; }
    if (addAfterPricing && amount === null) { toast.error("Enter a unit price before adding this stock to a quotation"); return; }
    const url = draftImage.trim();
    if (!photo && url) { try { const parsed = new URL(url); if (parsed.protocol !== "https:" || parsed.username || parsed.password) throw new Error(); } catch { toast.error("Use a public HTTPS image URL"); return; } }
    const controller = lifecycle.current;
    if (!controller || controller.signal.aborted) return;
    committing.current = true;
    setSavingPrice(true);
    let photoSaved = false;
    try {
      // Save the photo first; a failed upload leaves the price draft intact.
      if (photo) {
        const uploaded = await uploadGodownImage(lot.id, photo, controller.signal, floorId);
        if (controller.signal.aborted) return;
        photoSaved = true; setPhoto(null); setDraftImage(uploaded.image || ""); onUpdated(uploaded);
      }
      const updated = await updateGodownDetails(lot.id, { unit_price: amount, price_variants: draftVariants.map(row => ({ label: row.label.trim(), price: Number(row.price) })), ...(!photo && url !== (lot.image || "") ? { image: url || null } : {}) }, controller.signal, floorId);
      if (controller.signal.aborted) return;
      setVariantIndex(null); toast.success("Stock price and image updated"); setEditingPrice(false); onUpdated(updated);
      if (addAfterPricing) { setAddAfterPricing(false); onAdd(null); }
    } catch (error: any) { if (!controller.signal.aborted) toast.error(error?.detail || error?.message || (photoSaved ? "Photo saved; price could not be updated. Try saving again." : "Could not update stock details")); }
    finally { committing.current = false; if (!controller.signal.aborted) setSavingPrice(false); }
  };
  return <View testID={`godown-lot-${lot.id}`} style={[styles.card, compact && styles.cardCompact, { width }]}>
    <View style={styles.cardHead}><ProductImage source={lot.image || null} style={compact ? [styles.image, styles.imageCompact] : styles.image} fallbackLabel={lot.sku} statusMessages={stockPhotoMessages} accessibilityLabel={`${lot.name} product image`} /><View style={{ flex: 1, minWidth: 0, gap: 3 }}><Text style={styles.brand}>{lot.brand_name || "Unbranded"}</Text><Text style={type.titleMd} numberOfLines={2}>{lot.name}</Text><Text style={type.caption}>{lot.sku}{lot.finish ? ` · ${lot.finish}` : ""}{lot.size ? ` · ${lot.size}` : ""}</Text></View></View>
    <View style={styles.availability}><Feather name={lot.available_qty > 0 ? "check-circle" : "archive"} size={15} color={lot.available_qty > 0 ? colors.success : colors.onSurfaceMuted} /><Text style={styles.available}>{lot.quantity_missing ? "Quantity not recorded" : lot.available_qty > 0 ? `${lot.available_qty} in stock` : "Out of stock · 0 units"} · {lot.stock_value == null ? "Value not recorded" : `${money(lot.stock_value)} stock value`}</Text></View>
    <Text style={type.caption}>{lot.quantity_missing ? "Record quantity before using this stock" : `${lot.transferable_qty ?? lot.available_qty} available to transfer`}</Text>
    {lot.quantity_missing && canEditPricing ? <Pressable accessibilityRole="button" accessibilityLabel={`Record quantity for ${lot.name}`} testID={`godown-count-${lot.id}`} disabled={savingCount || savingPrice} onPress={() => setCounting(value => !value)} style={styles.details}><Text style={styles.detailsText}>{counting ? "Close quantity count" : "Record quantity"}</Text></Pressable> : null}
    {counting && lot.quantity_missing ? <View style={styles.editForm}>
      <Text style={type.titleSm}>Record a confirmed count</Text>
      <Text style={type.caption}>Use the same unit as this product&apos;s purchases and quotations. Do not enter boxes unless this product is tracked in boxes.</Text>
      <Text style={type.caption}>Counted quantity (required)</Text>
      <TextInput accessibilityLabel="Counted stock quantity" testID={`godown-count-qty-${lot.id}`} value={countQty} onChangeText={setCountQty} keyboardType="decimal-pad" editable={!savingCount} style={styles.search} />
      <Text style={type.caption}>Count date (YYYY-MM-DD, required)</Text>
      <TextInput accessibilityLabel="Stock count date" testID={`godown-count-date-${lot.id}`} value={countDate} onChangeText={setCountDate} maxLength={10} editable={!savingCount} style={styles.search} />
      <Text style={type.caption}>Count source or reason (required)</Text>
      <TextInput accessibilityLabel="Stock count source or reason" testID={`godown-count-reason-${lot.id}`} value={countReason} onChangeText={setCountReason} maxLength={280} editable={!savingCount} style={styles.search} />
      {countError ? <View style={{ gap: spacing.sm }}><Text accessibilityRole="alert" style={[type.body, { color: colors.error }]}>{countError}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Refresh quantity details for ${lot.name}`} disabled={savingCount || savingPrice} onPress={() => void refreshCountLot()} style={styles.details}><Text style={styles.detailsText}>Refresh this lot</Text></Pressable></View> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={`Save quantity count for ${lot.name}`} testID={`godown-count-save-${lot.id}`} disabled={savingCount || savingPrice} onPress={() => void saveCount()} style={styles.details}><Text style={styles.detailsText}>{savingCount ? "Recording count…" : "Save quantity count"}</Text></Pressable>
    </View> : null}
    <Text style={type.body}>Unit price: {lot.unit_price == null ? "Not recorded" : money(lot.unit_price)}</Text>
    {canEditPricing ? <Pressable accessibilityRole="button" testID={`godown-edit-${lot.id}`} disabled={savingPrice} accessibilityLabel={`Edit price and image for ${lot.name}`} onPress={() => { if (editingPrice) { setEditingPrice(false); setAddAfterPricing(false); } else openEditor(); }} style={styles.editControl}><Text style={styles.detailsText}>{editingPrice ? "Cancel edit" : "Edit price & image"}</Text></Pressable> : null}
    {editingPrice ? <View style={styles.editForm}>
      <Text style={type.titleSm}>{addAfterPricing ? "Price this stock" : "Stock price & image"}</Text>
      {addAfterPricing ? <Text style={type.bodyMuted}>Enter a unit price to add this stock to a quotation.</Text> : null}
      <Text style={type.caption}>Unit price (₹)</Text>
      <TextInput ref={priceInput} testID={`godown-price-${lot.id}`} accessibilityLabel={`Unit price for ${lot.name}`} editable={!savingPrice} value={draftPrice} onChangeText={setDraftPrice} keyboardType="decimal-pad" placeholder="Unit price (₹)" style={styles.search} />
      <Text style={type.caption}>{addAfterPricing ? "This price will be used on the new quotation." : "Leave the price blank if it is not recorded."}</Text>
      <Text style={type.caption}>Product image</Text>
      <TextInput testID={`godown-image-url-${lot.id}`} accessibilityLabel={`Image URL for ${lot.name}`} editable={!savingPrice} value={draftImage} onChangeText={value => { setDraftImage(value); setPhoto(null); }} placeholder="Public HTTPS image URL" autoCapitalize="none" style={styles.search} />
      <View style={styles.actions}><Pressable testID={`godown-upload-${lot.id}`} accessibilityRole="button" accessibilityLabel={`Upload image for ${lot.name}`} disabled={savingPrice || pickingPhoto} onPress={() => void pickPhoto()} style={styles.details}><Text style={styles.detailsText}>{pickingPhoto ? "Choosing…" : photo ? "Choose another photo" : "Upload photo"}</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={`Remove image for ${lot.name}`} disabled={savingPrice} onPress={() => { setPhoto(null); setDraftImage(""); }} style={styles.details}><Text style={styles.detailsText}>Remove image</Text></Pressable></View>
      {photo ? <View style={styles.actions}><ProductImage source={photo.uri} style={styles.image} fallbackLabel="Selected photo" /><Text style={type.caption}>{photo.fileName || "Selected photo"} · ready to upload</Text></View> : null}
      {draftVariants.map((row, index) => <View key={index} style={styles.actions}><TextInput accessibilityLabel={`Price variant ${index + 1} label`} editable={!savingPrice} value={row.label} onChangeText={label => setDraftVariants(rows => rows.map((item, i) => i === index ? { ...item, label } : item))} placeholder="Variant name" style={[styles.search, { flex: 1 }]} /><TextInput accessibilityLabel={`Price variant ${index + 1} price`} editable={!savingPrice} value={row.price} onChangeText={variantPrice => setDraftVariants(rows => rows.map((item, i) => i === index ? { ...item, price: variantPrice } : item))} keyboardType="decimal-pad" placeholder="Price (₹)" style={[styles.search, { flex: 1 }]} /><Pressable accessibilityRole="button" accessibilityLabel={`Remove price variant ${index + 1}`} disabled={savingPrice} onPress={() => setDraftVariants(rows => rows.filter((_, i) => i !== index))} style={styles.details}><Feather name="x" size={16} color={colors.brand} /></Pressable></View>)}
      <View style={styles.actions}><Pressable accessibilityRole="button" disabled={savingPrice || draftVariants.length >= 20} onPress={() => setDraftVariants(rows => [...rows, { label: "", price: "" }])} style={styles.details}><Text style={styles.detailsText}>Add variant</Text></Pressable><Pressable accessibilityRole="button" testID={`godown-save-${lot.id}`} disabled={savingPrice || savingCount || pickingPhoto} onPress={() => void savePricing()} style={styles.add}><Text style={styles.addText}>{savingPrice ? "Saving…" : addAfterPricing ? "Save & add to quotation" : "Save price & image"}</Text></Pressable></View>
    </View> : null}
    {variants.length ? <View style={styles.chips}><Chip label={`Base · ${lot.unit_price == null ? "Not recorded" : money(lot.unit_price)}`} selected={variantIndex === null} onPress={() => setVariantIndex(null)} />{variants.map((variant, index) => <Chip key={`${variant.label}-${index}`} label={`${variant.label} · ${money(variant.price)}`} selected={variantIndex === index} onPress={() => setVariantIndex(index)} />)}</View> : null}
    <Text style={type.caption}>Arrival: {fmt(lot.transferred_at || lot.created_at)}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel={`${showHistory ? "Hide" : "Show"} stock history for ${lot.name}`} onPress={() => setShowHistory(!showHistory)}><Text style={styles.detailsText}>{showHistory ? "Hide" : "Show"} stock history</Text></Pressable>
    {showHistory ? <View style={styles.provenance}>
      <Text style={styles.provenanceTitle}>Source</Text><Text style={type.bodyMuted}>{lot.source_customer_name ? `Original purchase for ${lot.source_customer_name}` : lot.source_type === "warehouse_import" ? "Imported from the godown stock workbook" : lot.source_type === "manual" ? "Added as a product outside the catalog" : "Added directly from the catalog"}</Text>
      {lot.source_purchased_at ? <Text style={type.caption}>Purchased: {fmt(lot.source_purchased_at)}</Text> : null}
      {lot.source_purchase_order_id ? <Text style={type.caption}>Purchase order: {lot.source_purchase_order_id}</Text> : null}
      {lot.source_quotation_id ? <Text style={type.caption}>Source quotation: {lot.source_quotation_id}</Text> : null}
      <Text style={[styles.provenanceTitle, { marginTop: 8 }]}>Arrival in godown</Text><Text style={type.caption}>{fmt(lot.transferred_at)} · {lot.reason || "Stock intake"}</Text>
      {lot.transferred_by_name ? <Text style={type.caption}>Recorded by {lot.transferred_by_name}</Text> : null}
      <Text style={[styles.provenanceTitle, { marginTop: 8 }]}>Stock cycle</Text><Text style={type.caption}>{lot.quantity_missing ? "Quantity not recorded" : `${lot.quantity_counts?.length ? "Counted opening balance" : "Received"} ${lot.qty_received} · Allocated ${lot.qty_received - lot.available_qty} · Available ${lot.available_qty}`}</Text>
      {(lot.quantity_counts || []).map(count => <Text key={count.id} style={type.caption}>Counted {count.qty} stock units on {count.counted_on} · {count.actor_name} · {count.reason}</Text>)}
      {loadingHistory ? <Text accessibilityLiveRegion="polite" style={type.body}>Loading stock movements…</Text> : null}
      {historyError ? <View><Text accessibilityRole="alert" style={type.body}>{historyError}</Text><Pressable accessibilityRole="button" accessibilityLabel={`Retry stock history for ${lot.name}`} onPress={() => void loadHistory(history?.next_offset ?? 0)} style={styles.details}><Text style={styles.detailsText}>Retry stock history</Text></Pressable></View> : null}
      {(history?.allocations || lot.allocations || []).map(allocation => <Text key={allocation.id} style={type.caption}>{fmt(allocation.allocated_at)} · {allocation.qty} to {allocation.quotation_number || allocation.quotation_id || "quotation"}{allocation.customer_name ? ` for ${allocation.customer_name}` : ""}{allocation.allocated_by_name ? ` · ${allocation.allocated_by_name}` : ""}</Text>)}
      {(history?.customer_transfers || lot.customer_transfers || []).map((transfer) => <Text key={transfer.id} style={type.caption}>{fmt(transfer.created_at)} · {transfer.qty} transferred to {transfer.recipient_customer_name}{transfer.recipient_purchase_item_id ? " · PO Final moved to In Box" : ""}{transfer.discount_pct ? ` · ${transfer.discount_pct}% discount` : ""}</Text>)}
      {history?.next_offset != null ? <Pressable accessibilityRole="button" accessibilityLabel={`Load more stock history for ${lot.name}`} disabled={loadingHistory} onPress={() => void loadHistory(history.next_offset!)} style={styles.details}><Text style={styles.detailsText}>Load more movements</Text></Pressable> : null}
    </View> : null}
    {compact ? <>
      <View testID="godown-phone-primary-actions" style={styles.phonePrimaryActions}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Transfer ${lot.name} to a customer`} disabled={!canTransfer} onPress={onTransfer} style={[styles.phoneSecondaryAction, !canTransfer && { opacity: .45 }]}><Feather name="repeat" size={16} color={colors.brand} /><Text style={styles.detailsText}>Transfer</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={needsPrice && canEditPricing ? `Set price and add ${lot.name} to a new quotation` : `Add ${lot.name}${selectedPrice == null ? "" : ` at ${money(selectedPrice)}`} to a new quotation`} disabled={savingPrice || !canTransfer || (needsPrice && !canEditPricing)} onPress={() => needsPrice ? openEditor(true) : onAdd(variantIndex)} style={[styles.phonePrimaryAction, (savingPrice || !canTransfer || (needsPrice && !canEditPricing)) && { opacity: .45 }]}><Feather name="plus" size={17} color={colors.onBrand} /><Text style={styles.addText}>{needsPrice && canEditPricing ? "Set price & add" : "Add to quotation"}</Text></Pressable>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel={`View ${isCatalogProduct ? "catalog" : "stock"} details for ${lot.name}`} onPress={isCatalogProduct ? onViewDetails : () => setShowHistory(value => !value)} style={styles.phoneDetailsAction}><Text style={styles.detailsText}>View {isCatalogProduct ? "catalog" : "stock"} details</Text><Feather name="arrow-up-right" size={15} color={colors.brand} /></Pressable>
    </> : <>
      <Pressable accessibilityRole="button" accessibilityLabel={`Transfer ${lot.name} to a customer`} disabled={!canTransfer} onPress={onTransfer} style={[styles.transferAction, !canTransfer && { opacity: .45 }]}><Feather name="repeat" size={16} color={colors.brand} /><Text style={styles.detailsText}>Transfer to customer</Text></Pressable>
      <View style={styles.actions}><Pressable accessibilityRole="button" accessibilityLabel={`View ${isCatalogProduct ? "catalog" : "stock"} details for ${lot.name}`} onPress={isCatalogProduct ? onViewDetails : () => setShowHistory(value => !value)} style={styles.details}><Feather name="external-link" size={16} color={colors.brand} /><Text style={styles.detailsText}>View details</Text></Pressable><Pressable accessibilityRole="button" accessibilityLabel={needsPrice && canEditPricing ? `Set price and add ${lot.name} to a new quotation` : `Add ${lot.name}${selectedPrice == null ? "" : ` at ${money(selectedPrice)}`} to a new quotation`} disabled={savingPrice || !canTransfer || (needsPrice && !canEditPricing)} onPress={() => needsPrice ? openEditor(true) : onAdd(variantIndex)} style={[styles.add, (savingPrice || !canTransfer || (needsPrice && !canEditPricing)) && { opacity: .45 }]}><Feather name="plus" size={17} color={colors.onBrand} /><Text style={styles.addText}>{needsPrice && canEditPricing ? "Set price & add" : "Add to quotation"}</Text></Pressable></View>
    </>}
    {!canTransfer ? <Text style={type.caption}>{lot.quantity_missing ? "Record the stock quantity before quoting or transferring this lot." : "No transferable units are available. Check the stock history for allocations."}</Text> : needsPrice && !canEditPricing ? <Text style={type.caption}>Ask a stock manager to record a price before adding this lot to a quotation.</Text> : null}
  </View>;
}
const styles = StyleSheet.create({ matchRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, padding: spacing.md, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary }, form: { padding: spacing.lg, gap: spacing.sm, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary }, manualFields: { gap: spacing.sm }, editForm: { gap: spacing.sm, padding: spacing.md, backgroundColor: colors.surface, borderRadius: radius.md }, editControl: { minHeight: 44, justifyContent: "center" }, suggestion: { padding: spacing.sm, borderBottomWidth: 1, borderColor: colors.border }, page: { padding: spacing.xl, gap: spacing.lg, maxWidth: 1320, width: "100%", alignSelf: "center" }, pagePhone: { padding: spacing.md }, totalsPhone: { flexWrap: "wrap" }, totalPhone: { minWidth: 0, flexGrow: 1, flexBasis: 120, padding: spacing.md }, exportActions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }, exportButton: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingHorizontal: spacing.md, borderWidth: 1, borderColor: colors.brandBorder, borderRadius: radius.md, backgroundColor: colors.brandTint }, center: { flex: 1, alignItems: "center", justifyContent: "center", gap: 12 }, hero: { flexDirection: "row", gap: spacing.xl, padding: spacing.xl, borderRadius: radius.lg, backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, heroPhone: { flexDirection: "column", gap: spacing.md, padding: spacing.md }, total: { minWidth: 128, padding: spacing.lg, borderRadius: radius.md, backgroundColor: colors.brandTint, justifyContent: "center" }, totalNumber: { fontSize: 30, fontWeight: "800", color: colors.brand }, totalLabel: { fontSize: 12, color: colors.onSurfaceSecondary }, search: { minHeight: 48, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, paddingHorizontal: 14, backgroundColor: colors.surfaceSecondary, color: colors.onSurface }, chips: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingRight: 16 }, chip: { minHeight: 44, justifyContent: "center", paddingHorizontal: 14, borderRadius: 999, backgroundColor: colors.surfaceTertiary }, chipSelected: { backgroundColor: colors.brand }, chipText: { fontWeight: "600", color: colors.onSurfaceSecondary }, chipTextSelected: { color: colors.onBrand }, result: { ...type.caption, color: colors.onSurfaceMuted }, grid: { gap: spacing.md }, gridWide: { flexDirection: "row", flexWrap: "wrap", alignItems: "stretch" }, card: { maxWidth: 420, minWidth: 0, padding: spacing.lg, gap: spacing.md, borderRadius: radius.md, backgroundColor: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, cardCompact: { padding: spacing.md, gap: spacing.sm }, cardHead: { flexDirection: "row", gap: 12 }, image: { width: 74, height: 74, borderRadius: radius.sm, backgroundColor: colors.surfaceTertiary }, imageCompact: { width: 84, height: 84 }, brand: { ...type.overline, color: colors.brand }, availability: { flexDirection: "row", alignItems: "center", gap: 6 }, available: { flex: 1, minWidth: 0, fontWeight: "700", color: colors.onSurface }, provenance: { paddingTop: 12, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, provenanceTitle: { fontSize: 11, fontWeight: "700", color: colors.onSurfaceSecondary, textTransform: "uppercase", letterSpacing: .5 }, actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }, phonePrimaryActions: { flexDirection: "row", gap: spacing.sm }, phoneSecondaryAction: { minHeight: 48, flex: 1, paddingHorizontal: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.brandBorder, backgroundColor: colors.brandTint, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center" }, phonePrimaryAction: { minHeight: 48, flex: 1.2, paddingHorizontal: spacing.sm, borderRadius: radius.md, backgroundColor: colors.brand, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center" }, phoneDetailsAction: { minHeight: 44, flexDirection: "row", gap: spacing.xs, alignItems: "center", justifyContent: "center" }, transferAction: { height: 48, flexGrow: 0, flexShrink: 0, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.brandBorder, backgroundColor: colors.brandTint, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center" }, details: { minHeight: 48, paddingHorizontal: 12, borderRadius: radius.md, borderWidth: 1, borderColor: colors.brandBorder, backgroundColor: colors.brandTint, flexDirection: "row", gap: 6, alignItems: "center", justifyContent: "center", flex: 1 }, detailsText: { flexShrink: 1, textAlign: "center", fontWeight: "700", color: colors.brand }, add: { minHeight: 48, borderRadius: radius.md, backgroundColor: colors.brand, flexDirection: "row", gap: 8, alignItems: "center", justifyContent: "center", flex: 1.25 }, addText: { flexShrink: 1, textAlign: "center", fontWeight: "700", color: colors.onBrand }, empty: { alignItems: "center", padding: 48, gap: 8 } });
