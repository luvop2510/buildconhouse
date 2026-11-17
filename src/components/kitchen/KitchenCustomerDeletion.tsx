import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { api, ApiError } from "@/src/api/client";
import type { KitchenProject } from "@/src/api/kitchenProjects";
import { STAGE_LABELS } from "@/src/api/kitchenProjects";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";
import { Alert, Button, Sheet } from "@/src/components/ds";
import { Text } from "@/src/components/AppText";
import { spacing, type } from "@/src/theme/tokens";
import { useKitchenProject } from "./KitchenProjectState";

type Preview = { customer_id: string; customer_name: string; confirmation: string; projects: { id: string; reference: string; stage: keyof typeof STAGE_LABELS }[] };

export function KitchenCustomerDeletion({ project }: { project: KitchenProject }) {
  const { deletionReview: visible, setDeletionReview, writesBusy, writesPending, finishDeletion } = useKitchenProject();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const pending = useRef(false);
  const generation = useRef(0);
  const onClose = () => { if (!pending.current) setDeletionReview(false); };
  useEffect(() => {
    const current = ++generation.current;
    setPreview(null); setError("");
    if (!visible || writesBusy) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api.get<Preview>(`/kitchen-customer-deletion/${encodeURIComponent(project.id)}`, { floorId: KITCHEN_FLOOR_ID, signal: controller.signal }).then(value => {
      if (current === generation.current) setPreview(value);
    }).catch(failure => { if (current === generation.current && !controller.signal.aborted) setError(failure?.detail || failure?.message || "Could not review this customer. Retry."); })
      .finally(() => { if (current === generation.current) setLoading(false); });
    return () => { generation.current += 1; controller.abort(); };
  }, [visible, project.id, attempt, writesBusy]);
  const remove = async () => {
    if (!visible || !preview || pending.current || writesPending()) return;
    const current = generation.current;
    pending.current = true; setBusy(true); setError("");
    try {
      await api.delete(`/kitchen-customer-deletion/${encodeURIComponent(project.id)}?confirmation=${encodeURIComponent(preview.confirmation)}`, { floorId: KITCHEN_FLOOR_ID });
      if (current !== generation.current) return;
      finishDeletion();
    } catch (failure) {
      if (current === generation.current) {
        const message = failure instanceof Error ? failure.message : "Deletion was not confirmed. Retry with the same confirmation.";
        setError(message);
        if (failure instanceof ApiError) {
          const code = (failure.payload as { code?: string } | undefined)?.code;
          if (failure.status === 403 || failure.status === 409 && code !== "mutation_admission_busy") setPreview(null);
        }
      }
    } finally { pending.current = false; if (current === generation.current) setBusy(false); }
  };
  return <Sheet scroll visible={visible} onClose={onClose} title="Delete Kitchen customer" testID="kitchen-customer-delete-dialog">
    <View style={{ gap: spacing.md }}>
      <Text style={type.bodyStrong}>{preview?.customer_name || project.customer.name}</Text>
      <Text style={type.body}>Delete this customer and all their Kitchen projects from active records? Saved history and documents will be retained for controlled recovery. Other floors are preserved.</Text>
      {writesBusy ? <Text accessibilityLiveRegion="polite" style={type.caption}>Waiting for the current save to finish…</Text> : loading ? <Text style={type.caption}>Reviewing affected projects…</Text> : null}
      {preview?.projects.map(row => <Text key={row.id} style={type.body}>{row.reference} · {STAGE_LABELS[row.stage]}</Text>)}
      {error ? <Alert tone="error" title="Deletion not confirmed" description={error} /> : null}
      {error && !preview && !loading && !writesBusy ? <Button label="Review again" variant="secondary" onPress={() => setAttempt(value => value + 1)} /> : null}
      <Button label="Confirm delete customer" variant="danger" disabled={!preview || loading || busy || writesBusy} loading={busy} onPress={() => void remove()} testID="kitchen-customer-delete-confirm" />
      <Button label="Cancel" variant="secondary" disabled={busy} onPress={onClose} />
    </View>
  </Sheet>;
}
