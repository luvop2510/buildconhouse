import Feather from "@expo/vector-icons/Feather";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Overlay } from "@/src/design/Overlay";
import { colors } from "@/src/theme/tokens";
import { useBuilder } from "../context/BuilderContext";

export const PRODUCT_SORT_OPTIONS = [
  { k: "popular", label: "Most used", icon: "trending-up" },
  { k: "recent", label: "Recent", icon: "clock" },
  { k: "price_asc", label: "Price: low to high", icon: "arrow-up" },
  { k: "price_desc", label: "Price: high to low", icon: "arrow-down" },
  { k: "name", label: "Name: A–Z", icon: "align-left" },
] as const;

// Compact catalog controls live away from the grid. Choices apply immediately,
// so closing or pressing Back never leaves hidden, unapplied filter state.
export function ProductFilterSheet({ open, onClose, facets }: {
  open: boolean; onClose: () => void; facets: Record<string, { value: string }[]>;
}) {
  const b = useBuilder();
  // Closed filters must not rebuild every choice when a quotation line changes.
  if (!open) return null;
  return <Overlay open={open} onClose={onClose} title="Filters and sort" presentation="drawer" scroll={false}
    testID="quotation-product-filters" footer={<>
      <Pressable accessibilityRole="button" testID="explorer-filter-reset" style={styles.reset} onPress={() => {
        b.setSelectedBrandId(null); b.setSelectedCategoryId(null); b.setSelectedSizes([]); b.setSortKey("popular");
      }}><Text style={styles.resetLabel}>Reset</Text></Pressable>
      <Pressable accessibilityRole="button" testID="explorer-filter-done" style={styles.apply} onPress={onClose}>
        <Text style={styles.applyLabel}>Show products</Text><Feather name="arrow-right" size={16} color={colors.onBrand} />
      </Pressable>
    </>}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <View testID="mobile-brand-selector" style={styles.section}>
        <Text accessibilityRole="header" style={styles.title}>Brand</Text>
        <Choice label="All brands" active={!b.selectedBrandIds.length} onPress={() => b.setSelectedBrandId(null)} testID="mobile-brand-all" />
        {b.brands.map(brand => <Choice key={brand.id} label={brand.name} count={brand.product_count} active={b.selectedBrandIds.includes(brand.id)}
          onPress={() => b.setSelectedBrandId(brand.id)} testID={`mobile-brand-${brand.name}`} />)}
      </View>
      <View testID="mobile-category-selector" style={styles.section}>
        <Text accessibilityRole="header" style={styles.title}>Category</Text>
        {b.categoriesLoading ? <View style={styles.loading} testID="explorer-categories-loading"><ActivityIndicator size="small" /><Text>Loading categories…</Text></View> : null}
        {b.categoriesError ? <Pressable accessibilityRole="button" accessibilityLabel="Retry product categories" testID="explorer-category-retry"
          onPress={b.retryCategories} style={styles.choice}><Feather name="refresh-cw" size={16} color={colors.onSurface} /><Text style={styles.label}>{b.categoriesError}</Text></Pressable> : null}
        <Choice label="All categories" active={!b.selectedCategoryIds.length} onPress={() => b.setSelectedCategoryId(null)} testID="mobile-category-all" />
        {b.categoriesForRail.map(category => <Choice key={category.id} label={category.name} count={category.product_count} active={b.selectedCategoryIds.includes(category.id)}
          onPress={() => b.setSelectedCategoryId(category.id)} testID={`mobile-category-${category.name}`} />)}
      </View>
      {facets.sizes?.length ? <View style={styles.section}>
        <Text accessibilityRole="header" style={styles.title}>Size</Text>
        <Choice label="All sizes" active={!b.selectedSizes.length} onPress={() => b.setSelectedSizes([])} multiple />
        {facets.sizes.map(option => <Choice key={option.value} label={option.value} active={b.selectedSizes.includes(option.value)} multiple onPress={() => b.setSelectedSizes(
          b.selectedSizes.includes(option.value) ? b.selectedSizes.filter(value => value !== option.value) : [...b.selectedSizes, option.value]
        )} />)}
      </View> : null}
      <View style={styles.section} testID="mobile-sort-selector">
        <Text accessibilityRole="header" style={styles.title}>Sort by</Text>
        {PRODUCT_SORT_OPTIONS.map(option => <Choice key={option.k} label={option.label} active={b.sortKey === option.k}
          onPress={() => b.setSortKey(option.k)} testID={`sort-${option.k}`} />)}
      </View>
    </ScrollView>
  </Overlay>;
}

function Choice({ label, count, active, onPress, testID, multiple = false }: {
  label: string; count?: number; active: boolean; onPress: () => void; testID?: string; multiple?: boolean;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: active }} aria-pressed={active} onPress={onPress}
    testID={testID} style={[styles.choice, active && styles.selected]}>
    <Text style={[styles.label, active && styles.selectedLabel]}>{label}</Text>
    {count != null ? <Text style={styles.count}>{count}</Text> : null}
    <Feather name={multiple ? active ? "check-square" : "square" : active ? "check-circle" : "circle"} size={18} color={active ? colors.brand : colors.onSurfaceMuted} />
  </Pressable>;
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 24 },
  section: { gap: 6 },
  title: { fontSize: 15, fontWeight: "700", color: colors.onSurface, marginBottom: 6 },
  choice: { minHeight: 48, flexDirection: "row", alignItems: "center", gap: 12, padding: 12, borderRadius: 10, backgroundColor: colors.surfaceSecondary },
  selected: { backgroundColor: colors.brandTint },
  label: { flex: 1, fontSize: 14, color: colors.onSurface },
  selectedLabel: { fontWeight: "700" },
  count: { fontSize: 12, color: colors.onSurfaceMuted },
  loading: { flexDirection: "row", gap: 8, minHeight: 44, alignItems: "center" },
  reset: { minHeight: 48, justifyContent: "center", paddingHorizontal: 16, borderRadius: 10, borderWidth: 1, borderColor: colors.border },
  resetLabel: { fontSize: 14, fontWeight: "700", color: colors.onSurface },
  apply: { flex: 1, minHeight: 48, justifyContent: "center", flexDirection: "row", gap: 8, alignItems: "center", paddingHorizontal: 16, borderRadius: 10, backgroundColor: colors.brand },
  applyLabel: { fontSize: 14, fontWeight: "700", color: colors.onBrand },
});
