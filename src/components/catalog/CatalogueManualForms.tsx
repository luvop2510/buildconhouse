import { useRef, useState } from "react";
import { View } from "react-native";

import { type CatalogueOptions, catalogueApi } from "@/src/api/catalogueManagement";
import { Text } from "@/src/components/AppText";
import { Dropdown } from "@/src/components/ds";
import { Alert, Button, Card, TextField } from "@/src/components/ui";
import { TILES_FLOOR_ID } from "@/src/constants/floors";
import { spacing, type } from "@/src/theme/tokens";

export function catalogueError(error: unknown, fallback: string) {
  if (!error || typeof error !== "object") return fallback;
  const { status, payload } = error as { status?: number; payload?: { detail?: unknown } };
  if (status === 403) return "You do not have permission for this action in the selected department.";
  const detail = payload?.detail;
  return status && status < 500 && typeof detail === "string" && detail.length <= 400 ? detail : fallback;
}

const PRODUCT_FIELDS = [
  { key: "sku", label: "Article number" },
  { key: "name", label: "Product name" },
  { key: "mrp", label: "MRP", numeric: true },
  { key: "price", label: "Offer price (optional)", numeric: true },
  { key: "finish", label: "Finish (optional)" },
  { key: "size", label: "Size (optional)" },
] as const;
const TILE_UNITS = [{ id: "piece", label: "Per piece" }, { id: "box", label: "Per box" }, { id: "sqft", label: "Per square foot" }];
const TILE_FIELDS = [
  { key: "pcs_per_box", label: "Pieces per box", numeric: true },
  { key: "sqft_per_box", label: "Square feet per box", numeric: true },
  { key: "rate_per_sqft", label: "Rate per square foot (optional)", numeric: true },
] as const;
const money = /^(?:\d+(?:\.\d+)?|\.\d+)$/;
const price = (value: string | undefined) => {
  const input = value?.trim() || "";
  const number = Number(input);
  return money.test(input) && Number.isFinite(number) ? number : undefined;
};

export function CatalogueManualForms({ options, floorId, request, refresh, signal }: {
  options: CatalogueOptions;
  floorId: string;
  request: ReturnType<typeof catalogueApi>;
  refresh: () => void;
  signal: AbortSignal;
}) {
  const [action, setAction] = useState<"brand" | "category" | "product" | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [brandId, setBrandId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const set = (key: string, value: string) => setFields(fields => ({ ...fields, [key]: value }));
  const change = (next: typeof action) => {
    if (pending.current) return;
    setAction(next); setFields({}); setBrandId(""); setCategoryId(""); setError(""); setNotice("");
  };
  const can = (capability: string) => options.capabilities.includes(capability);
  const categories = options.categories.filter(category => !category.brand_id || category.brand_id === brandId);
  const brand = options.brands.find(brand => brand.id === brandId);
  const category = categories.find(category => category.id === categoryId);
  const title = { brand: "Add brand", category: "Add category", product: "Add single product" };
  if (!["catalogue_brands", "catalogue_categories", "catalogue_products_add"].some(can)) return null;

  const save = async () => {
    if (!action || pending.current || signal.aborted) return;
    const name = fields.name?.trim() || "";
    const sku = fields.sku?.trim() || "";
    const maxName = action === "product" ? 200 : 100;
    if (!name || name.length > maxName) { setError(`Enter a name of up to ${maxName} characters.`); return; }
    if (action !== "brand" && !brand) { setError("Choose a brand."); return; }
    const mrp = price(fields.mrp);
    const offer = price(fields.price);
    const tile = floorId === TILES_FLOOR_ID;
    const pieces = price(fields.pcs_per_box);
    const area = price(fields.sqft_per_box);
    const unit = fields.price_unit;
    const rate = price(fields.rate_per_sqft);
    if (action === "product") {
      if (!category || !sku || sku.length > 200 || mrp === undefined || fields.price?.trim() && offer === undefined) {
        setError("Enter an article number, a category and valid prices."); return;
      }
      if (tile && (!fields.size?.trim() || !unit)) { setError("Enter a tile size and choose a price unit."); return; }
      if (tile && (
        (unit !== "piece" || fields.pcs_per_box?.trim()) && (!pieces || !Number.isInteger(pieces)) ||
        (unit === "sqft" || fields.sqft_per_box?.trim()) && !area ||
        fields.rate_per_sqft?.trim() && rate === undefined
      )) {
        setError("Enter valid box measurements for the selected price unit."); return;
      }
    }
    pending.current = true;
    setBusy(true); setError(""); setNotice("");
    try {
      if (action === "brand") await request.createBrand(name);
      if (action === "category") await request.createCategory(brandId, name);
      if (action === "product") await request.createProduct({
        brand_id: brandId, category_id: categoryId, sku, name, mrp: mrp!, price: offer,
        finish: fields.finish?.trim() || undefined, size: fields.size?.trim() || undefined,
        specs: tile ? {
          price_unit: unit, ...(pieces ? { pcs_per_box: pieces } : {}), ...(area ? { sqft_per_box: area } : {}),
          ...(rate === undefined ? {} : { rate_per_sqft: rate }),
        } : undefined,
      });
      if (signal.aborted) return;
      setFields({}); setAction(null);
      setNotice(action === "product" ? "Product saved to the catalogue." : action === "brand" ? "Brand saved." : "Category saved.");
      refresh();
    } catch (cause) {
      if (!signal.aborted) setError(catalogueError(cause, "We couldn’t confirm the save. Check the catalogue before trying again."));
    } finally {
      pending.current = false;
      if (!signal.aborted) setBusy(false);
    }
  };

  return <Card style={{ gap: spacing.md }} testID="catalogue-manual">
    <Text accessibilityRole="header" style={type.titleMd}>Add to the catalogue</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      {can("catalogue_brands") ? <Button label={title.brand} variant="secondary" disabled={busy} onPress={() => change("brand")} /> : null}
      {can("catalogue_categories") ? <Button label={title.category} variant="secondary" disabled={busy} onPress={() => change("category")} /> : null}
      {can("catalogue_products_add") ? <Button label={title.product} variant="secondary" disabled={busy} onPress={() => change("product")} /> : null}
    </View>
    {notice ? <Alert tone="success" title={notice} /> : null}
    {action ? <>
      <Text accessibilityRole="header" style={type.titleSm}>{title[action]}</Text>
      {action !== "brand" ? <Dropdown label={brand?.name || "Choose a brand"} testID="catalogue-manual-brand"
        items={options.brands.map(brand => ({ label: brand.name, disabled: busy, onPress: () => { setBrandId(brand.id); setCategoryId(""); } }))} /> : null}
      {action === "product" ? <>
        <Dropdown label={category?.name || "Choose a category"} testID="catalogue-manual-category"
          items={categories.map(category => ({ label: category.name, disabled: busy || !brandId, onPress: () => setCategoryId(category.id) }))} />
        {floorId === TILES_FLOOR_ID ? <Dropdown label={TILE_UNITS.find(unit => unit.id === fields.price_unit)?.label || "Choose a price unit"}
          testID="catalogue-tile-price-unit" items={TILE_UNITS.map(unit => ({ label: unit.label, disabled: busy, onPress: () => set("price_unit", unit.id) }))} /> : null}
        {[...PRODUCT_FIELDS, ...(floorId === TILES_FLOOR_ID ? TILE_FIELDS : [])].map(field =>
          <TextField key={field.key} label={field.key === "size" && floorId === TILES_FLOOR_ID ? "Size" : field.label} value={fields[field.key] || ""} editable={!busy}
            autoCapitalize={field.key === "sku" ? "none" : undefined} maxLength={200}
            keyboardType={"numeric" in field && field.numeric ? "decimal-pad" : "default"} onChangeText={value => set(field.key, value)} />)}
      </> : <TextField label={action === "brand" ? "Brand name" : "Category name"} value={fields.name || ""} maxLength={100} editable={!busy}
        onChangeText={value => set("name", value)} />}
      {error ? <Alert tone="error" title={error} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        <Button label="Save" icon="check" loading={busy} onPress={() => void save()} testID="catalogue-manual-save" />
        <Button label="Cancel" variant="ghost" disabled={busy} onPress={() => change(null)} />
      </View>
    </> : null}
  </Card>;
}
