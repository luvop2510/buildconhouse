import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Button } from "@/src/components/ui";
import { Sheet } from "@/src/design/components";
import { colors, money, spacing, type } from "@/src/theme/tokens";

export type CatalogPriceReview = { token: string | null; changes: { position?: number; line_id: string; sku: string; name: string; old_unit_price: number; new_unit_price: number; changed_at?: string; reason?: "catalog_price_changed" | "source_price_unverified" }[] };

export function QuotationPriceReviewSheet({ review, busy, onClose, onChoose }: { review: CatalogPriceReview | null; busy: boolean; onClose: () => void; onChoose: (choice: "keep" | "latest") => void }) {
  const hasUnverified = review?.changes.some(change => change.reason === "source_price_unverified");
  return <Sheet open={Boolean(review?.changes.length)} onClose={onClose} title={hasUnverified ? "Review quotation prices" : "Company prices have changed"} width={560}
    footer={<View style={{ gap: spacing.sm }}><Button label="Keep original prices" variant="ghost" onPress={() => onChoose("keep")} disabled={busy} testID="keep-original-prices" fullWidth /><Button label="Apply latest prices" onPress={() => onChoose("latest")} loading={busy} testID="apply-latest-prices" fullWidth /></View>}>
    <Text style={type.body}>Choose the prices to use before creating this purchase order. Keeping the original prices preserves your quoted offer. Applying latest prices replaces the listed offer rates and retains existing discounts.</Text>
    <View style={{ gap: spacing.md, marginTop: spacing.md }}>{review?.changes.map((change, index) => <View key={`${change.position ?? index}:${change.line_id}`} style={{ padding: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 8 }}><Text style={{ fontWeight: "700", color: colors.onSurface }}>{change.name}</Text><Text style={type.caption}>{change.sku}</Text><Text style={type.body}>{money(change.old_unit_price)} → {money(change.new_unit_price)}</Text>{change.reason === "source_price_unverified" ? <Text style={type.body}>Original source price unavailable; confirm original or latest offer.</Text> : null}{change.changed_at ? <Text style={type.caption}>Updated {new Date(change.changed_at).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" })}</Text> : null}</View>)}</View>
  </Sheet>;
}
