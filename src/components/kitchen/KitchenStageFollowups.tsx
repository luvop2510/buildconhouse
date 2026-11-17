import { useCallback, useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { Text } from "@/src/components/AppText";
import { Alert } from "@/src/components/ds";
import { kitchenProjectsApi, kitchenRequestKey, STAGE_LABELS, type KitchenProject, type KitchenStage, type KitchenStageFollowup } from "@/src/api/kitchenProjects";
import { spacing } from "@/src/theme/tokens";
import { KitchenDateField } from "./KitchenFilters";
import { KitchenButton as Button, KitchenTextField as TextField, kitchenColors as colors, kitchenType as type } from "./KitchenPrimitives";
import { Choice, displayDate, KitchenPanel } from "./shared";
import { useKitchenDraft, useKitchenProject } from "./KitchenProjectState";

function useFollowupHistory(id: string, stage?: KitchenStage, enabled = true) {
  const [rows, setRows] = useState<KitchenStageFollowup[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<{ controller: AbortController; identity: string } | null>(null);
  const identity = `${id}:${stage || "all"}`;
  const currentIdentity = useRef(identity);
  currentIdentity.current = identity;
  const load = useCallback(async (nextPage = 1) => {
    if (!enabled || request.current && request.current.identity === identity) return;
    request.current?.controller.abort();
    const token = { controller: new AbortController(), identity };
    request.current = token;
    setLoading(true); setError("");
    try {
      const result = await kitchenProjectsApi.followups(id, stage, nextPage, token.controller.signal);
      if (request.current !== token || token.controller.signal.aborted || currentIdentity.current !== identity) return;
      setRows(previous => nextPage === 1 ? result.rows : [...previous, ...result.rows.filter(row => !previous.some(existing => existing.id === row.id))]);
      setTotal(result.total); setPage(nextPage);
    } catch (cause) {
      if (request.current === token && !token.controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not load follow-ups.");
    } finally {
      if (request.current === token) { request.current = null; setLoading(false); }
    }
  }, [enabled, id, identity, stage]);
  useEffect(() => {
    setRows([]); setTotal(0); setPage(0); setError("");
    if (enabled) void load();
    return () => { request.current?.controller.abort(); request.current = null; };
  }, [load, enabled]);
  return { rows, total, loading, error, reload: () => load(1), more: () => load(page + 1) };
}

function FollowupRows({ rows }: { rows: KitchenStageFollowup[] }) {
  return <>{rows.map(row => <View key={row.id} testID={`kitchen-followup-record-${row.number}`} style={{ gap: spacing.xs, paddingVertical: spacing.sm, borderBottomWidth: 1, borderColor: colors.border }}>
    <Text style={type.bodyStrong}>{STAGE_LABELS[row.stage]} · Follow-Up {row.number}</Text>
    <Text style={type.body}>{displayDate(row.date)} · {row.interaction_type}</Text>
    {row.notes ? <Text style={type.body}>{row.notes}</Text> : null}
    <Text style={type.caption}>{row.actor_name} · Recorded {displayDate(row.created_at)}</Text>
  </View>)}</>;
}

/** The history sheet and consolidated profile can use the same persisted log. */
export function KitchenFollowupHistory({ projectId }: { projectId: string }) {
  const history = useFollowupHistory(projectId);
  return <KitchenPanel title="Follow-Up history">
    {history.loading ? <Text accessibilityLiveRegion="polite" style={type.caption}>Loading follow-ups…</Text> : null}
    {history.error ? <Alert tone="error" title="Follow-ups unavailable" description={history.error} action={<Button label="Retry follow-up history" onPress={history.reload} />} /> : null}
    {!history.loading && !history.error && !history.rows.length ? <Text style={type.bodyMuted}>No follow-ups recorded.</Text> : null}
    <FollowupRows rows={history.rows} />
    {history.rows.length < history.total ? <Button label="Show earlier follow-ups" variant="secondary" loading={history.loading} onPress={history.more} /> : null}
  </KitchenPanel>;
}

export function KitchenStageFollowups({ project, stage, disabled = false }: { project: KitchenProject; stage: KitchenStage; disabled?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [initial, setInitial] = useState(() => ({ date: "", notes: "", interaction_type: "Visit" as "Visit" | "Call", idempotency_key: kitchenRequestKey() }));
  const draftKey = `followup.${stage}.entry`;
  const [draft, setDraft] = useKitchenDraft(draftKey, initial);
  const { resetDraftValue, beginAuxiliaryWrite } = useKitchenProject();
  const history = useFollowupHistory(project.id, stage, expanded);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const editableStages = (project.permissions as { editable_stages?: KitchenStage[] } | undefined)?.editable_stages;
  const canSave = !disabled && project.permissions?.can_update === true && (!editableStages || editableStages.includes(stage));
  const save = async () => {
    if (pending.current || !canSave || !draft.date) return;
    const finishWrite = beginAuxiliaryWrite();
    if (!finishWrite) return;
    pending.current = true; setSaving(true); setError(""); setSaved("");
    try {
      const result = await kitchenProjectsApi.addFollowup(project.id, { ...draft, stage });
      if (!mounted.current) return;
      resetDraftValue(draftKey);
      setInitial({ date: "", notes: "", interaction_type: "Visit", idempotency_key: kitchenRequestKey() });
      setEntryOpen(false); setSaved(`Follow-Up ${result.number} saved.`);
      void history.reload();
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "Could not save follow-up. Retry this entry.");
    } finally { finishWrite(); pending.current = false; if (mounted.current) setSaving(false); }
  };
  return <KitchenPanel>
    <Pressable accessibilityRole="button" accessibilityLabel="Follow-Up" accessibilityState={{ expanded }} aria-expanded={expanded} testID="kitchen-followup-toggle" onPress={() => setExpanded(value => !value)} style={{ minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
      <Text style={type.titleSm}>Follow-Up</Text><Feather accessible={false} name={expanded ? "chevron-up" : "chevron-down"} size={20} color={colors.onSurfaceSecondary} />
    </Pressable>
    {expanded ? <View testID="kitchen-followup-content" style={{ gap: spacing.md }}>
      {history.loading ? <Text style={type.caption}>Loading follow-ups…</Text> : null}
      {history.error ? <Alert tone="error" title="Follow-ups unavailable" description={history.error} action={<Button label="Retry follow-ups" onPress={history.reload} />} /> : null}
      <FollowupRows rows={history.rows} />
      {!history.rows.length && !history.loading && !history.error ? <Text style={type.bodyMuted}>No follow-ups recorded.</Text> : null}
      {history.rows.length < history.total ? <Button label="Show earlier follow-ups" variant="secondary" loading={history.loading} onPress={history.more} /> : null}
      {saved ? <Text accessibilityLiveRegion="polite" style={type.caption}>{saved}</Text> : null}
      {entryOpen ? <View style={{ gap: spacing.md }} testID="kitchen-followup-form">
        <Text style={type.bodyStrong}>Follow-Up {(history.rows[0]?.number || 0) + 1}</Text>
        <KitchenDateField label="Follow-Up date" value={draft.date} onChange={date => setDraft(value => ({ ...value, date }))} disabled={!canSave || saving} defaultToToday={false} testID="kitchen-followup-date" />
        <TextField label="Notes" value={draft.notes} onChangeText={notes => setDraft(value => ({ ...value, notes }))} maxLength={250} editable={canSave && !saving} testID="kitchen-followup-notes" />
        <Choice label="Interaction type" value={draft.interaction_type} values={["Visit", "Call"] as const} onChange={interaction_type => setDraft(value => ({ ...value, interaction_type }))} disabled={!canSave || saving} testID="kitchen-followup-type" />
        {error ? <Alert tone="error" title="Follow-up not confirmed" description={error} /> : null}
        <Button label="Save Follow-Up" loading={saving} disabled={!canSave || !draft.date} onPress={save} testID="kitchen-followup-save" />
      </View> : canSave ? <Button label="Add Follow-Up" icon="plus" variant="secondary" disabled={history.loading || Boolean(history.error)} onPress={() => { setEntryOpen(true); setSaved(""); }} testID="kitchen-followup-add" /> : null}
    </View> : null}
  </KitchenPanel>;
}
