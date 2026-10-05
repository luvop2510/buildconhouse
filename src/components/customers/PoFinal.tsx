import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { api } from "@/src/api/client";
import { Button, Card, EmptyState } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { useBp } from "@/src/design/responsive";
import { colors, money, spacing, type } from "@/src/theme/tokens";
import { downloadApiFile } from "@/src/utils/downloadFile";

type FinalQuotation = {
  id: string; number: string; status: string; updated_at?: string | null; grand_total: number;
};
type FinalItem = {
  id: string; product_id?: string | null; sku?: string | null; name: string;
  qty: number; unit_price: number; total: number; source?: string | null;
  original_qty?: number; original_total?: number; godown_transferred_qty?: number; godown_credit_amount?: number;
  stage?: string | null; room?: string | null; brand_name?: string | null;
};
type FinalChange = {
  id: string; at?: string | null; type: string; description: string;
  qty?: number | null; amount?: number | null; quotation_id?: string | null;
};
type PoFinalData = {
  customer: { id: string; name: string };
  quotations: FinalQuotation[];
  quotation_id?: string | null;
  quotation_number?: string | null;
  status?: string | null;
  doc_type?: string | null;
  items: FinalItem[];
  changes: FinalChange[];
  total: number;
  items_total?: number;
  transportation_fee?: number;
  original_total?: number;
  godown_credit_amount?: number;
  payment_extra_amount: number;
  payable_total: number;
  generated_at?: string | null;
};

function dateLabel(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

export function PoFinal({ customerId }: { customerId: string }) {
  const router = useRouter();
  const { isPhone } = useBp();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [data, setData] = useState<PoFinalData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const query = selectedId ? `?quotation_id=${encodeURIComponent(selectedId)}` : "";
      setData(await api.get<PoFinalData>(`/customers/${encodeURIComponent(customerId)}/po-final${query}`));
    } catch (e: any) {
      setError(e?.detail || "Could not load PO Final. Please try again.");
    } finally {
      setLoading(false);
    }
  }, [customerId, selectedId]);

  useEffect(() => { void load(); }, [load]);

  const download = async () => {
    if (!data?.quotation_id) return;
    setDownloading(true);
    try {
      const query = `?quotation_id=${encodeURIComponent(data.quotation_id)}`;
      const name = (data.customer.name || "Customer").replace(/[\\/:*?"<>|]/g, "").trim();
      const ok = await downloadApiFile(
        `/customers/${encodeURIComponent(customerId)}/po-final/pdf${query}`,
        `${name} PO Final ${data.quotation_number || "quotation"}.pdf`,
        "PO Final PDF",
      );
      if (ok) toast.success("PO Final PDF ready");
    } catch (e: any) {
      toast.error(e?.detail || "Could not download the PO Final PDF. Please try again.");
    } finally { setDownloading(false); }
  };

  if (loading && !data) return <Card><ActivityIndicator color={colors.brand} accessibilityLabel="Loading PO Final" /></Card>;
  if (error && !data) return <Card><EmptyState
    icon={error.includes("No quotation exists") ? "file-text" : "alert-triangle"}
    title={error.includes("No quotation exists") ? "No quotation yet" : "PO Final unavailable"}
    subtitle={error.includes("No quotation exists") ? "Create a quotation for this customer to generate PO Final." : error}
    action={error.includes("No quotation exists") ? undefined : <Button label="Try again" icon="refresh-cw" onPress={() => void load()} />}
  /></Card>;
  if (!data) return null;

  return <View style={{ gap: spacing.lg }} testID="customer-po-final">
    <Card>
      <View style={{ flexDirection: isPhone ? "column" : "row", alignItems: isPhone ? "stretch" : "center", justifyContent: "space-between", gap: spacing.md }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={type.titleLg}>PO Final</Text>
          <Text style={type.bodyMuted}>Final customer quotation after product, stock, transfer, and amount changes.</Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          <Button label="Refresh" icon="refresh-cw" variant="secondary" size="sm" onPress={() => void load()} loading={loading} testID="po-final-refresh" />
          <Button label="Download PDF" icon="download" size="sm" onPress={() => void download()} disabled={!data.quotation_id || loading} loading={downloading} testID="po-final-download" />
        </View>
      </View>
      {error ? <Text accessibilityRole="alert" style={[type.caption, { color: colors.error, marginTop: spacing.sm }]}>{error}</Text> : null}
    </Card>

    {data.quotations.length > 0 ? <Card>
      <Text style={[type.overline, { marginBottom: spacing.sm }]}>Quotation</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {data.quotations.map((quotation) => <Pressable
          key={quotation.id}
          accessibilityRole="button"
          accessibilityState={{ selected: data.quotation_id === quotation.id }}
          accessibilityLabel={`Show PO Final for ${quotation.number}`}
          onPress={() => setSelectedId(quotation.id)}
          style={[styles.choice, data.quotation_id === quotation.id && styles.choiceSelected]}
          testID={`po-final-quotation-${quotation.id}`}
        >
          <Text style={[type.bodySm, data.quotation_id === quotation.id && { color: colors.onBrand }]}>{quotation.number} · {quotation.status}</Text>
        </Pressable>)}
      </View>
      {data.quotation_id ? <View style={{ marginTop: spacing.md, alignSelf: "flex-start" }}><Button
        label="Manage products and amounts" icon="edit-3" variant="secondary" size="sm"
        onPress={() => data.doc_type === "tiles_selection" || data.doc_type === "tiles_quotation"
          ? router.push(`/(admin)/tiles/${data.doc_type === "tiles_selection" ? "selection" : "quotation"}?id=${encodeURIComponent(data.quotation_id!)}` as any)
          : router.push(`/(admin)/quotations/new?quotationId=${encodeURIComponent(data.quotation_id!)}` as any)}
        testID="po-final-manage-quotation"
      /></View> : null}
    </Card> : null}

    {!data.quotation_id ? <Card><EmptyState icon="file-text" title="No quotation yet" subtitle="Create a quotation for this customer to generate PO Final." /></Card> : <>
      <Card>
        <Text style={type.overline}>Final amount · {data.quotation_number || "Quotation"}</Text>
        <Text style={[type.titleLg, { marginTop: spacing.sm }]}>{money(data.payable_total)}</Text>
        <Text style={type.caption}>Products {money(data.items_total ?? data.total)}{data.transportation_fee ? ` · Transportation ${money(data.transportation_fee)}` : ""}{data.payment_extra_amount ? ` · Additional charges ${money(data.payment_extra_amount)}` : ""}</Text>
        {(data.godown_credit_amount || 0) > 0 ? <Text style={type.caption}>Original order {money(data.original_total ?? data.total)} · Moved to godown −{money(data.godown_credit_amount || 0)}</Text> : null}
        {data.generated_at ? <Text style={type.caption}>Updated {dateLabel(data.generated_at)}</Text> : null}
      </Card>

      <Card padding={0}>
        <Text style={[type.overline, { padding: spacing.lg, paddingBottom: spacing.sm }]}>Final product list · {data.items.length}</Text>
        {data.items.length === 0 ? <View style={{ padding: spacing.lg }}><Text style={type.bodyMuted}>No products in this quotation.</Text></View> : data.items.map((item, index) => <View key={`${item.id}-${index}`} style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth }]}>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={type.bodyStrong}>{item.name}</Text>
            <Text style={type.caption}>{[item.sku, item.brand_name, item.room].filter(Boolean).join(" · ")}</Text>
            {item.source || item.stage ? <Text style={type.caption}>{[item.source?.replace(/_/g, " "), item.stage?.replace(/_/g, " ")].filter(Boolean).join(" · ")}</Text> : null}
            {(item.godown_transferred_qty || 0) > 0 ? <Text style={type.caption}>Moved {item.godown_transferred_qty} to godown · original qty {item.original_qty ?? item.qty} · credit {money(item.godown_credit_amount || 0)}</Text> : null}
          </View>
          <View style={{ alignItems: isPhone ? "flex-start" : "flex-end", minWidth: isPhone ? "100%" : 135 }}>
            <Text style={type.bodySm}>{item.qty} × {money(item.unit_price)}</Text>
            <Text style={type.bodyStrong}>{money(item.total)}</Text>
          </View>
        </View>)}
      </Card>

      <Card padding={0}>
        <Text style={[type.overline, { padding: spacing.lg, paddingBottom: spacing.sm }]}>Changes made · {data.changes.length}</Text>
        {data.changes.length === 0 ? <View style={{ padding: spacing.lg }}><Text style={type.bodyMuted}>No changes recorded after the quotation was created.</Text></View> : data.changes.map((change, index) => <View key={`${change.id}-${index}`} style={[styles.row, { borderTopWidth: StyleSheet.hairlineWidth }]}>
          <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
            <Text style={type.bodyStrong}>{change.description}</Text>
            <Text style={type.caption}>{[dateLabel(change.at), change.type.replace(/_/g, " ")].filter(Boolean).join(" · ")}</Text>
          </View>
          {typeof change.amount === "number" ? <Text style={type.bodySm}>{money(change.amount)}</Text> : null}
        </View>)}
      </Card>
    </>}
  </View>;
}

const styles = StyleSheet.create({
  choice: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md, borderRadius: 8, borderWidth: 1, borderColor: colors.border },
  choiceSelected: { backgroundColor: colors.brand, borderColor: colors.brand },
  row: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.md, borderTopColor: colors.divider },
});
