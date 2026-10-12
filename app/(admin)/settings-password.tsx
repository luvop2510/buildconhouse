import { hasMinimumPasswordLength } from "@/src/utils/passwordPolicy";
// Settings > Account > Password. The one real gap the audit found — there
// was no change-password endpoint or screen anywhere before this.
import { useRouter } from "expo-router";
import { useState } from "react";
import { View } from "react-native";

import { api } from "@/src/api/client";
import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { toast } from "@/src/components/Toast";
import { Button, Card, TextField } from "@/src/components/ui";
import { Text } from "@/src/components/AppText";
import { useAuth } from "@/src/state/auth";
import { type, spacing } from "@/src/theme/tokens";

export default function SettingsPassword() {
  const router = useRouter();
  const { staff } = useAuth();
  const isOwner = staff?.role === "owner";
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (saving || !isOwner) return;
    setError(null);
    if (!current) { setError("Enter your current password"); return; }
    if (!hasMinimumPasswordLength(next)) { setError("New password must be at least 6 characters"); return; }
    if (next !== confirm) { setError("Passwords don't match"); return; }
    setSaving(true);
    try {
      await api.post("/auth/change-password", { current_password: current, new_password: next });
      toast.show("Password updated");
      router.replace("/(admin)/settings");
    } catch (e: any) {
      setError(e?.detail || e?.message || "Current password is incorrect");
    } finally {
      setSaving(false);
    }
  };

  if (!isOwner) return (
    <AdminPage title="Password managed by owner" back={() => router.back()}>
      <Card testID="owner-managed-password"><Text style={type.body}>Your password is managed by the owner. Contact the owner to change it.</Text></Card>
    </AdminPage>
  );

  return (
    <AdminPage title="Change password" back={() => router.back()}>
      <View style={{ gap: spacing.lg }}>
        <Card style={{ gap: spacing.md }}>
          <TextField testID="current-password-input" label="Current password" value={current} onChangeText={setCurrent} secureTextEntry placeholder="••••••••" autoCapitalize="none" editable={!saving} />
          <TextField testID="new-password-input" label="New password" value={next} onChangeText={setNext} secureTextEntry placeholder="At least 6 characters" autoCapitalize="none" editable={!saving} />
          <TextField testID="confirm-password-input" label="Confirm new password" value={confirm} onChangeText={setConfirm} secureTextEntry placeholder="Re-enter new password" autoCapitalize="none" editable={!saving} error={error} />
          <Button testID="save-password-btn" label="Update password" icon="lock" loading={saving} onPress={submit} fullWidth />
        </Card>
      </View>
    </AdminPage>
  );
}
