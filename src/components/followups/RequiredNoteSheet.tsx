import { useEffect, useRef, useState } from "react";
import { ScrollView, View } from "react-native";

import { Alert, Button, Sheet, TextField } from "@/src/components/ui";
import { spacing } from "@/src/theme/tokens";

export type FollowupNoteAction = {
  title: string;
  subtitle?: string;
  confirmLabel?: string;
  execute: (notes: string) => Promise<void>;
};

/** Stage an action until its explanation is saved with the same request. */
export function RequiredNoteSheet({ action, onClose }: {
  action: FollowupNoteAction | null;
  onClose: () => void;
}) {
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => { setNotes(""); setError(null); }, [action]);

  const submit = async () => {
    if (!action || !notes.trim() || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError(null);
    try { await action.execute(notes.trim()); onClose(); }
    catch (failure: any) { setError(typeof failure?.detail === "string" ? failure.detail : failure?.message || "Could not save this change. Please retry."); }
    finally { busy.current = false; setSaving(false); }
  };

  return <Sheet visible={!!action} onClose={() => { if (!busy.current) onClose(); }}
    variant="modal" title={action?.title || "Update follow-up"} subtitle={action?.subtitle} width={440} dismissable={!saving}
    footer={<>
      <Button label="Cancel" variant="secondary" disabled={saving} onPress={onClose} />
      <View style={{ flex: 1 }} />
      <Button label={action?.confirmLabel || "Save change"} icon="check" disabled={!notes.trim() || saving}
        loading={saving} onPress={() => void submit()} testID="save-followup-change" />
    </>}
  >
    <ScrollView style={{ flexShrink: 1, minHeight: 0 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
      {error ? <Alert tone="error" title={error} /> : null}
      <TextField label="Follow-up note *" helper="Required — explain this change. It is saved in the follow-up history."
        value={notes} onChangeText={setNotes} placeholder="What happened, and why are you making this change?"
        multiline autoFocus editable={!saving} testID="followup-change-note" />
    </ScrollView>
  </Sheet>;
}
