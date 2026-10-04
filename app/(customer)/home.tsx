// Customer Portal — responsive dashboard. This is a secure, read-only
// document portal: customer identity, latest quotation, and support only.
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";

import { api } from "@/src/api/client";
import { Button, Card, StatusBadge } from "@/src/components/ui";
import {
  CustomerEmpty,
  CustomerError,
  CustomerFooterLinks,
  CustomerHeader,
  CustomerPage,
  CustomerSectionHeading,
  CustomerSkeletonCard,
  formatCustomerDate,
} from "@/src/components/customer/CustomerPortal";
import { useAuth } from "@/src/state/auth";
import { colors, spacing, type, money } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";

type Quote = {
  id: string;
  number: string;
  status: string;
  grand_total: number;
  created_at: string;
  items?: unknown[];
};

export default function CustomerDashboard() {
  const { isPhone } = useBp();
  const { customer, logout } = useAuth();
  const router = useRouter();
  const [quotes, setQuotes] = useState<Quote[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

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
      setLoading(false);
    } catch {
      if (signal?.aborted) return;
      setError(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const retry = () => {
    const controller = new AbortController();
    void load(controller.signal);
  };
  const latest = quotes?.[0] ?? null;
  const displayEmail = customer?.email;

  return (
    <CustomerPage
      testID="customer-dashboard"
      header={(
        <CustomerHeader
          brand
          customerName={customer?.company || customer?.name}
          onLogout={async () => { await logout(); router.replace("/(auth)/login"); }}
        />
      )}
      contentStyle={styles.dashboardContent}
    >
      <Card style={styles.accountCard}>
        <Text style={type.overline}>Your account</Text>
        <View style={styles.accountRow}>
          <Feather name="user" size={16} color={colors.onSurfaceMuted} />
          <Text style={styles.accountValue} numberOfLines={3}>{customer?.name || "Customer"}</Text>
        </View>
        {displayEmail ? (
          <View style={styles.accountRow}>
            <Feather name="mail" size={16} color={colors.onSurfaceMuted} />
            <Text style={type.body} numberOfLines={2}>{displayEmail}</Text>
          </View>
        ) : null}
      </Card>

      <CustomerSectionHeading title="Latest quotation" />

      {loading && !quotes ? (
        <CustomerSkeletonCard />
      ) : error && !quotes ? (
        <CustomerError onRetry={retry} />
      ) : !latest ? (
        <Card style={styles.emptyCard}>
          <CustomerEmpty title="No quotations yet" subtitle="Your sales representative will share estimates here." />
        </Card>
      ) : (
        <Card testID={`latest-quote-${latest.id}`} onPress={() => router.push(`/(customer)/quotes/${latest.id}`)} style={styles.quoteCard}>
          <View style={[styles.quoteHeader, isPhone && styles.stackOnPhone]}>
            <View style={styles.quoteCopy}>
              <Text style={[type.mono, { color: colors.onSurfaceMuted }]} numberOfLines={2}>{latest.number}</Text>
              <Text style={[type.titleMd, styles.quoteMeta]} numberOfLines={2}>
                {(latest.items?.length ?? 0)} item{(latest.items?.length ?? 0) === 1 ? "" : "s"} · {formatCustomerDate(latest.created_at)}
              </Text>
            </View>
            <StatusBadge status={latest.status} />
          </View>
          <View style={styles.divider} />
          <View style={[styles.quoteFooter, isPhone && styles.stackOnPhone]}>
            <View style={styles.totalCopy}>
              <Text style={type.caption}>Grand total</Text>
              <Text style={styles.total} numberOfLines={2}>{money(latest.grand_total)}</Text>
            </View>
            <Button
              testID="latest-view-btn"
              label="Open quotation"
              icon="arrow-right"
              size="sm"
              variant="secondary"
              fullWidth={isPhone}
              onPress={() => router.push(`/(customer)/quotes/${latest.id}`)}
            />
          </View>
        </Card>
      )}

      <Button
        testID="view-all-quotations-btn"
        label={quotes ? `View all quotations (${quotes.length})` : "View all quotations"}
        icon="list"
        variant="secondary"
        fullWidth
        onPress={() => router.push("/(customer)/quotes")}
      />

      <Card style={{ ...styles.supportCard, ...(isPhone ? styles.stackOnPhone : {}) }}>
        <View style={styles.supportCopy}>
          <Text style={styles.supportTitle}>Need help?</Text>
          <Text style={styles.supportSubtitle}>Contact your BuildCon House sales representative using the details on your quotation.</Text>
        </View>
      </Card>

      <CustomerFooterLinks />
    </CustomerPage>
  );
}

const styles = StyleSheet.create({
  dashboardContent: { paddingTop: spacing.lg },
  accountCard: { gap: spacing.sm },
  accountRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm, minHeight: 28 },
  accountValue: { ...type.bodyStrong, flex: 1, minWidth: 0 },
  emptyCard: { padding: 0 },
  quoteCard: { gap: spacing.md },
  quoteHeader: { flexDirection: "row", alignItems: "flex-start", flexWrap: "wrap", gap: spacing.sm },
  quoteCopy: { flex: 1, minWidth: 160, gap: 4 },
  quoteMeta: { marginTop: 2 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  quoteFooter: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: spacing.md },
  totalCopy: { flex: 1, minWidth: 120, gap: 2 },
  total: { ...type.monoLg, fontSize: 22, lineHeight: 30 },
  supportCard: { backgroundColor: colors.surfaceSecondary, borderColor: colors.border, flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.md },
  supportCopy: { flex: 1, minWidth: 160, gap: 2 },
  supportTitle: { ...type.titleMd, color: colors.onSurface },
  supportSubtitle: { ...type.bodySm, color: colors.onSurfaceMuted },
  stackOnPhone: { flexDirection: "column", alignItems: "stretch" },
});
