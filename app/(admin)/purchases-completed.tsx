import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { Button, EmptyState, ErrorState, PageHeader } from "@/src/components/ds";
import { useBp } from "@/src/design/responsive";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { downloadSectionExcel } from "@/src/utils/sectionExcel";

type CompletedCustomer = { id: string; name: string; count: number; completed_at?: string | null };

export default function CompletedPurchases() {
  const router = useRouter();
  const { isPhone } = useBp();
  const [customers, setCustomers] = useState<CompletedCustomer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setCustomers(await api.get<CompletedCustomer[]>("/purchases/customers/completed"));
    } catch (cause: any) {
      setError(cause?.detail || "Could not load completed customers.");
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const exportRows = () => void downloadSectionExcel({
    page: "Purchases", section: "Completed customers", filename: "purchases-completed-customers.xlsx",
    rows: [["Customer", "Delivered items", "Last delivered"], ...customers.map((customer) => [customer.name, customer.count, customer.completed_at || ""])],
  }).catch((cause: unknown) => toast.error(cause instanceof Error ? cause.message : "Could not export completed customers"));

  return <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
    <ScrollView contentContainerStyle={{ width: "100%", maxWidth: 1000, alignSelf: "center", padding: isPhone ? spacing.md : spacing.xl, gap: spacing.lg, paddingBottom: 100 }}>
      <PageHeader title="Completed customers" subtitle="Every tracked purchase item delivered" back={() => router.back()} />
      {!loading && !error && customers.length > 0 ? <Button label="Export completed customers .xlsx" icon="download" variant="secondary" onPress={exportRows} /> : null}
      {error ? <ErrorState title="Completed customers unavailable" subtitle={error} onRetry={() => void load()} /> : loading ? <View style={{ alignItems: "center", padding: spacing.xl }}><ActivityIndicator /></View> : customers.length === 0 ? <EmptyState icon="check-circle" title="No completed customers yet" subtitle="Customers appear here once all their tracked items are delivered." /> : customers.map((customer) => <Pressable key={customer.id} accessibilityRole="button" accessibilityLabel={`Open ${customer.name}`} onPress={() => router.push(`/(admin)/customers/${encodeURIComponent(customer.id)}` as never)} style={{ flexDirection: "row", alignItems: "center", gap: spacing.md, padding: spacing.lg, backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border }}>
        <View style={{ flex: 1, minWidth: 0 }}><Text style={type.titleMd} numberOfLines={1}>{customer.name}</Text><Text style={type.caption}>{customer.count} delivered item{customer.count === 1 ? "" : "s"}{customer.completed_at ? ` · ${new Date(customer.completed_at).toLocaleDateString("en-IN")}` : ""}</Text></View>
        <Feather name="chevron-right" size={18} color={colors.onSurfaceMuted} />
      </Pressable>)}
    </ScrollView>
  </SafeAreaView>;
}
