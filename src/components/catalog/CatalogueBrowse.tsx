import { useEffect, useState } from "react";
import { View } from "react-native";

import type { catalogueApi, CatalogueOptions } from "@/src/api/catalogueManagement";
import { Text } from "@/src/components/AppText";
import { Dropdown } from "@/src/components/ds";
import { Alert, Button, Card, TextField } from "@/src/components/ui";
import { spacing, type } from "@/src/theme/tokens";

export function CatalogueBrowse({ options, request, revision }: {
  options: CatalogueOptions;
  request: ReturnType<typeof catalogueApi>;
  revision: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [brandId, setBrandId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [skip, setSkip] = useState(0);
  const [retry, setRetry] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [data, setData] = useState<Awaited<ReturnType<typeof request.products>>>();
  const canView = options.capabilities.includes("catalogue_view");
  const categories = options.categories.filter(category => !brandId || !category.brand_id || category.brand_id === brandId);

  useEffect(() => {
    if (!expanded || !canView) return;
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    const timer = setTimeout(() => {
      const filters = { q: query.trim(), skip: String(skip),
        ...(brandId ? { brand_id: brandId } : {}), ...(categoryId ? { category_id: categoryId } : {}) };
      void request.products(filters, controller.signal).then(result => {
        if (!controller.signal.aborted) setData(result);
      }).catch(() => {
        if (!controller.signal.aborted) setError(true);
      }).finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [expanded, canView, query, brandId, categoryId, skip, retry, request, revision]);

  if (!canView) return null;
  return <Card style={{ gap: spacing.md }}>
    <Button label={expanded ? "Hide products" : "Browse products"} variant="secondary"
      onPress={() => setExpanded(value => !value)} />
    {expanded ? <>
      <TextField label="Find by article or name" value={query}
        onChangeText={value => { setQuery(value); setSkip(0); }} maxLength={120} />
      <Dropdown label={options.brands.find(brand => brand.id === brandId)?.name || "All brands"}
        items={[{ label: "All brands", onPress: () => { setBrandId(""); setCategoryId(""); setSkip(0); } },
          ...options.brands.map(brand => ({ label: brand.name, onPress: () => {
            setBrandId(brand.id); setCategoryId(""); setSkip(0);
          } }))]} />
      <Dropdown label={categories.find(category => category.id === categoryId)?.name || "All categories"}
        items={[{ label: "All categories", onPress: () => { setCategoryId(""); setSkip(0); } },
          ...categories.map(category => ({ label: category.name, onPress: () => {
            setCategoryId(category.id); setSkip(0);
          } }))]} />
      {loading ? <Text accessibilityLiveRegion="polite" style={type.caption}>Loading products…</Text> : null}
      {error ? <>
        <Alert tone="error" title="Could not load products." />
        <Button label="Retry products" onPress={() => setRetry(value => value + 1)} variant="secondary" />
      </> : null}
      {!loading && !error && data ? <>
        <Text accessibilityLiveRegion="polite" style={type.caption}>{data.total ? `${data.total} matching products` : "No matching products."}</Text>
        {data.items.map(product => <View key={product.listing_id || product.id} style={{ gap: spacing.xs }}>
          <Text style={type.bodyStrong}>{product.name}</Text>
          <Text style={type.caption}>{[product.sku, product.finish, product.size].filter(Boolean).join(" · ")}</Text>
          {typeof product.mrp === "number" && typeof product.price === "number" ? <Text style={type.caption}>
            MRP {product.mrp.toLocaleString("en-IN")} · Offer {product.price.toLocaleString("en-IN")}
          </Text> : null}
        </View>)}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {skip > 0 ? <Button label="Previous products" variant="secondary" onPress={() => setSkip(Math.max(0, skip - 24))} /> : null}
          {data.next_skip !== null ? <Button label="Next products" variant="secondary" onPress={() => setSkip(data.next_skip!)} /> : null}
        </View>
      </> : null}
    </> : null}
  </Card>;
}
