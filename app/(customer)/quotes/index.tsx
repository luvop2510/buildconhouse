// Customer Portal — responsive quotations list (read-only).
// Keep this route under `quotes` so it cannot collide with staff quotations.
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { usePortalQuotations } from "@/src/hooks/use-portal-quotations";
import { Button, Card, StatusBadge, TextField } from "@/src/components/ui";
import {
  CustomerEmpty,
  CustomerError,
  CustomerHeader,
  CustomerPage,
  CustomerSectionHeading,
  CustomerSkeletonCard,
  formatCustomerDate,
} from "@/src/components/customer/CustomerPortal";
import { colors, money, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";

const PAGE_SIZE = 20;

export default function CustomerQuotationsList() {
  const { isPhone } = useBp();
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  useEffect(() => {
    if (search.trim() === query) return;
    const timer = setTimeout(() => { setQuery(search.trim()); setPage(0); }, 250);
    return () => clearTimeout(timer);
  }, [search, query]);
  const { data, loading, refreshing, error, reload } = usePortalQuotations(PAGE_SIZE, page, query);
  const quotes = data?.items ?? null;
  const retry = () => { void reload(); };
  const onRefresh = () => reload();

  return (
    <CustomerPage
      testID="customer-quotes"
      header={<CustomerHeader title="Quotations" subtitle={data ? `${data.total} ${query ? "matching" : "total"}` : "Your shared estimates"} back={() => router.back()} />}
      contentStyle={styles.content}
      refreshControl={{ refreshing, onRefresh, tintColor: colors.brand }}
    >
      <CustomerSectionHeading title="Your documents" count={data?.total} />
      <TextField label="Find a quotation" placeholder="Quotation number or status" value={search} onChangeText={setSearch} testID="portal-quote-search" maxLength={120} />

      {error && quotes ? (
        <Card style={styles.refreshError}>
          <Text style={type.bodyMuted}>Couldn’t refresh your quotations.</Text>
          <Pressable onPress={retry} style={styles.retryButton} accessibilityRole="button" accessibilityLabel="Retry loading quotations">
            <Text style={styles.retryLabel}>Retry</Text>
          </Pressable>
        </Card>
      ) : null}

      {loading && !quotes ? (
        Array.from({ length: 4 }).map((_, index) => <CustomerSkeletonCard key={index} />)
      ) : error && !quotes ? (
        <CustomerError onRetry={retry} />
      ) : quotes?.length === 0 ? (
        <Card style={styles.emptyCard}>
          <CustomerEmpty title={query ? "No matching quotations" : "No quotations yet"} subtitle={query ? "Try another quotation number or status." : "Your sales representative will share estimates here."} />
        </Card>
      ) : (
        <>
          {quotes?.map((quote) => (
            <Card key={quote.id} testID={`quote-row-${quote.id}`} onPress={() => router.push(`/(customer)/quotes/${quote.id}`)} style={styles.quoteCard}>
              <View style={[styles.quoteRow, isPhone && styles.quoteRowPhone]}>
                <View style={styles.quoteCopy}>
                  <Text style={type.mono} numberOfLines={2}>{quote.number}</Text>
                  <Text style={styles.quoteTotal} numberOfLines={2}>{money(quote.grand_total)}</Text>
                  <Text style={type.caption} numberOfLines={2}>
                    {formatCustomerDate(quote.created_at)}
                    {quote.revision_count ? ` · Rev ${quote.revision_count}` : ""}
                    {quote.valid_until ? ` · Valid till ${formatCustomerDate(quote.valid_until, false).replace(/\s+\d{4}$/, "")}` : ""}
                  </Text>
                </View>
                <View style={[styles.quoteActions, isPhone && styles.quoteActionsPhone]}>
                  <StatusBadge status={quote.status} />
                  <View style={styles.chevronButton}>
                    <Feather name="chevron-right" size={18} color={colors.onSurfaceMuted} />
                  </View>
                </View>
              </View>
            </Card>
          ))}
        </>
      )}
      {page > 0 || data?.has_more ? <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.md }}>
        <Button label="Previous" variant="secondary" disabled={page === 0 || loading || search.trim() !== query} onPress={() => setPage(value => Math.max(0, value - 1))} />
        <Text style={type.caption}>Page {page + 1}</Text>
        <Button label="Next" variant="secondary" disabled={!data?.has_more || loading || search.trim() !== query} onPress={() => setPage(value => value + 1)} />
      </View> : null}
    </CustomerPage>
  );
}

const styles = StyleSheet.create({
  content: { paddingTop: spacing.lg },
  emptyCard: { padding: 0 },
  quoteCard: { paddingVertical: spacing.md, borderRadius: 4 },
  quoteRow: { flexDirection: "row", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.md, minHeight: 76 },
  quoteCopy: { flex: 1, minWidth: 160, gap: 4 },
  quoteTotal: { ...type.titleMd, fontVariant: ["tabular-nums"] },
  quoteActions: { alignItems: "flex-end", gap: spacing.sm, minWidth: 92 },
  quoteRowPhone: { flexDirection: "row", gap: spacing.sm },
  quoteActionsPhone: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", minWidth: 0, flexWrap: "wrap" },
  chevronButton: { minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" },
  refreshError: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.sm, backgroundColor: colors.errorBg, borderColor: colors.errorBorder },
  retryButton: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.sm },
  retryLabel: { ...type.bodyStrong, color: colors.error },
});
