// Settings > Account > Password. The one real gap the audit found — there
// was no change-password endpoint or screen anywhere before this.
import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { api } from "@/src/api/client";
import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { toast } from "@/src/components/Toast";
import { Button, Card, TextField } from "@/src/components/ui";
import { spacing } from "@/src/theme/tokens";

export default function SettingsPassword() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    if (next.length < 8) { setError("New password must be at least 8 characters"); return; }
    if (next !== confirm) { setError("Passwords don't match"); return; }
    setSaving(true);
    try {
      await api.post("/auth/change-password", { current_password: current, new_password: next });
      toast.show("Password updated");
      router.back();
    } catch (e: any) {
      setError(e?.message || "Current password is incorrect");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminPage title="Change password" back={() => router.back()}>
      <View style={{ gap: spacing.lg }}>
        <Card style={{ gap: spacing.md }}>
          <TextField testID="current-password-input" label="Current password" value={current} onChangeText={setCurrent} secureTextEntry placeholder="••••••••" autoCapitalize="none" />
          <TextField testID="new-password-input" label="New password" value={next} onChangeText={setNext} secureTextEntry placeholder="At least 8 characters" autoCapitalize="none" />
          <TextField testID="confirm-password-input" label="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry placeholder="Re-enter new password" autoCapitalize="none" error={error} />
          <Button testID="save-password-btn" label="Update password" icon="lock" loading={saving} onPress={submit} fullWidth />
        </Card>
      </View>
    </AdminPage>
  );
}
