import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { Button, Sheet } from "@/src/components/ui";
import { colors, spacing, type } from "@/src/theme/tokens";

type Preview = {
  customer_id: string;
  confirmation: string;
  counts: Record<string, number>;
  shared_records_preserved: number;
  private_files: number;
  furniture_candidates?: { id: string; customer_name?: string; customer_phone?: string; selected: boolean }[];
  selected_furniture_ids?: string[];
};

const labels: Record<string, string> = {
  customers: "Customer profiles", quotations: "Quotations", furniture_quotations: "Furniture quotations",
  kitchen_projects: "Kitchen projects", customer_orders: "Customer orders", purchase_orders: "Purchases",
  payments: "Payments", followups: "Follow-ups", walkins: "Walk-ins", dispatches: "Dispatches",
  chalans: "Delivery notes", ready_batches: "Ready batches", material_movements: "Material movements",
};

/** The Customers list is the single entry point for a complete data deletion. */
export function CustomerDataDeletionDialog({ customer, onClose, onDeleted }: {
  customer: { id: string; name: string; company?: string | null } | null;
  onClose: () => void;
  onDeleted: (id: string) => void;
}) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const id = customer?.id;
  const load = useCallback(async (selected: string[] = []) => {
    if (!id) return;
    const request = ++generation.current;
    setLoading(true);
    setPreview(null);
    setError("");
    try {
      const result = await api.get<Preview>(`/customers/${encodeURIComponent(id)}/deletion-preview?furniture_ids=${encodeURIComponent(selected.join(","))}`);
      if (request === generation.current) setPreview(result);
    } catch (e: any) {
      if (request === generation.current) setError(e?.detail || "The deletion summary could not load. Try again.");
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    setPreview(null);
    setError("");
    setDeleting(false);
    void load();
    return () => { generation.current += 1; };
  }, [load]);

  const remove = async () => {
    if (!id || !preview || deleting || preview.customer_id !== id) return;
    const request = generation.current;
    const targetId = id;
    setDeleting(true);
    setError("");
    try {
      await api.delete(`/customers/${encodeURIComponent(targetId)}?confirmation=${encodeURIComponent(preview.confirmation)}&furniture_ids=${encodeURIComponent((preview.selected_furniture_ids || []).join(","))}`);
      if (request === generation.current) onDeleted(targetId);
    } catch (e: any) {
      if (request === generation.current) {
        setError(e?.detail || "Customer data could not be deleted. Try again.");
        // Any conflict requires a fresh, explicit review. Never reuse a
        // previously confirmed count after a changed payment/order.
        setPreview(null);
      }
    } finally {
      if (request === generation.current) setDeleting(false);
    }
  };

  return <Sheet visible={!!customer} onClose={() => { if (!deleting) onClose(); }}
    title="Delete customer data?" subtitle={customer?.company || customer?.name} width={520} scroll
    testID="confirm-delete-customer-list"
    footer={<>
      <Button label="Cancel" variant="secondary" onPress={onClose} disabled={deleting} />
      <View style={{ flex: 1 }} />
      <Button label="Delete all customer data" variant="danger" onPress={remove} loading={deleting}
        disabled={!preview || loading || deleting} testID="confirm-delete-customer-list-confirm" />
    </>}>
    <View style={{ padding: spacing.lg, gap: spacing.md }}>
      <Text style={type.body}>This permanently removes this customer&apos;s quotations, orders, payments, purchases and activity across all explicitly linked floor profiles. This cannot be undone.</Text>
      {loading ? <View accessibilityRole="progressbar" accessibilityLabel="Loading deletion summary" style={{ padding: spacing.lg }}><ActivityIndicator color={colors.brand} /></View> : null}
      {preview ? <View testID="customer-deletion-summary" style={{ gap: spacing.sm }}>
        {Object.entries(preview.counts).filter(([key]) => labels[key]).map(([key, count]) =>
          <View key={key} style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md }}>
            <Text style={type.body}>{labels[key]}</Text><Text style={type.bodyStrong}>{count}</Text>
          </View>)}
        {(preview.furniture_candidates || []).length ? <View style={{ gap: spacing.sm }}>
          <Text style={type.bodyStrong}>Review older Furniture quotations</Text>
          <Text style={type.body}>These records share a phone number but have no profile link. Select only those belonging to this customer. Unselected records are kept.</Text>
          {(preview.furniture_candidates || []).map(candidate => <Pressable key={candidate.id} accessibilityRole="checkbox"
            accessibilityLabel={`Include furniture quotation ${candidate.customer_name || candidate.id}`}
            accessibilityState={{ checked: candidate.selected }} aria-checked={candidate.selected} onPress={() => {
              const selected = new Set(preview.selected_furniture_ids || []);
              if (selected.has(candidate.id)) selected.delete(candidate.id); else selected.add(candidate.id);
              void load([...selected]);
            }} style={{ minHeight: 44, paddingVertical: spacing.sm, gap: spacing.xs }}>
              <Text style={type.bodyStrong}>{candidate.selected ? "Selected · " : "Include · "}{candidate.customer_name || candidate.id}</Text>
              <Text style={type.caption}>{candidate.customer_phone} · {candidate.id}</Text>
            </Pressable>)}
        </View> : null}
        <Text style={type.caption}>Unrelated customers, catalog products and supplier stock remain. Shared inventory history is retained with this customer&apos;s identity removed. Reserved stock is released; delivered goods are not returned to stock.</Text>
      </View> : null}
      {error ? <View style={{ gap: spacing.sm }}>
        <Text accessibilityRole="alert" style={[type.body, { color: colors.error }]}>{error}</Text>
        <Button label="Review current data" variant="secondary" onPress={() => { void load(); }} disabled={loading || deleting} />
      </View> : null}
    </View>
  </Sheet>;
}
