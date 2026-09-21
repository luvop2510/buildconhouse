// Customer Portal — responsive quotations list (read-only).
// Keep this route under `quotes` so it cannot collide with staff quotations.
import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";

import { api } from "@/src/api/client";
import { Card, StatusBadge, TextField } from "@/src/components/ui";
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

type Quote = {
  id: string;
  number: string;
  status: string;
  grand_total: number;
  created_at: string;
  items?: unknown[];
  valid_until?: string;
  revisions?: unknown[];
};

export default function CustomerQuotationsList() {
  const { isPhone } = useBp();
  const router = useRouter();
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const visibleQuotes = useMemo(() => (quotes || []).filter(quote => `${quote.number} ${quote.status}`.toLowerCase().includes(search.trim().toLowerCase())), [quotes, search]);

  const load = useCallback(async (signal?: AbortSignal, preserveData = false) => {
    setError(false);
    if (!preserveData) {
      setLoading(true);
      setQuotes(null);
    }
    try {
      const result = await api.get<Quote[]>("/portal/quotations", { signal });
      if (signal?.aborted) return;
      setQuotes(Array.isArray(result) ? result : []);
    } catch {
      if (!signal?.aborted) setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const retry = () => { void load(); };
  const onRefresh = async () => {
    setRefreshing(true);
    await load(undefined, true);
    setRefreshing(false);
  };

  return (
    <CustomerPage
      testID="customer-quotes"
      header={<CustomerHeader title="Quotations" subtitle={quotes ? `${quotes.length} total` : "Your shared estimates"} back={() => router.back()} />}
      contentStyle={styles.content}
      refreshControl={{ refreshing, onRefresh, tintColor: colors.brand }}
    >
      <CustomerSectionHeading title="Your documents" count={quotes?.length} />
      {(quotes?.length || 0) > 0 ? <TextField label="Find a quotation" placeholder="Quotation number or status" value={search} onChangeText={setSearch} testID="portal-quote-search" /> : null}

      {loading && !quotes ? (
        Array.from({ length: 4 }).map((_, index) => <CustomerSkeletonCard key={index} />)
      ) : error && !quotes ? (
        <CustomerError onRetry={retry} />
      ) : quotes?.length === 0 ? (
        <Card style={styles.emptyCard}>
          <CustomerEmpty title="No quotations yet" subtitle="Your sales representative will share estimates here." />
        </Card>
      ) : (
        <>
          {error ? (
            <Card style={styles.refreshError}>
              <Text style={type.bodyMuted}>Couldn’t refresh your quotations.</Text>
              <Pressable onPress={retry} style={styles.retryButton} accessibilityRole="button" accessibilityLabel="Retry loading quotations">
                <Text style={styles.retryLabel}>Retry</Text>
              </Pressable>
            </Card>
          ) : null}
          {quotes && visibleQuotes.length === 0 ? <CustomerEmpty title="No matching quotations" subtitle="Try another quotation number or status." /> : null}
          {visibleQuotes.map((quote) => (
            <Card key={quote.id} testID={`quote-row-${quote.id}`} onPress={() => router.push(`/(customer)/quotes/${quote.id}`)} style={styles.quoteCard}>
              <View style={[styles.quoteRow, isPhone && styles.quoteRowPhone]}>
                <View style={styles.quoteCopy}>
                  <Text style={type.mono} numberOfLines={2}>{quote.number}</Text>
                  <Text style={styles.quoteTotal} numberOfLines={2}>{money(quote.grand_total)}</Text>
                  <Text style={type.caption} numberOfLines={2}>
                    {formatCustomerDate(quote.created_at)}
                    {quote.revisions?.length ? ` · Rev ${quote.revisions.length}` : ""}
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
