// Temporary customer portal invites use a separate password policy.
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { Button, Card, TextField } from "@/src/components/ui";
import { useAuth } from "@/src/state/auth";
import { useBp } from "@/src/design/responsive";
import { colors, spacing, type } from "@/src/theme/tokens";

export default function SetNewPassword() {
  const { isPhone, gutter } = useBp();
  const { kind, markPasswordChanged, logout } = useAuth();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (saving || kind !== "customer") return;
    setError(null);
    if (!current) { setError("Enter the temporary password you just used to sign in"); return; }
    if (next.length < 12) { setError("New password must be at least 12 characters"); return; }
    if (next !== confirm) { setError("Passwords don't match"); return; }
    setSaving(true);
    try {
      await api.post("/auth/customer/change-password", { current_password: current, new_password: next });
      markPasswordChanged();
      toast.success("Password set — you're all set");
    } catch (e: any) {
      setError(e?.detail || "That temporary password looks wrong. Check and try again.");
    } finally {
      setSaving(false);
    }
  };

  if (kind !== "customer") return null;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }}>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: "center", paddingHorizontal: gutter, paddingVertical: isPhone ? spacing.lg : spacing.xl }} keyboardShouldPersistTaps="handled">
          <Card style={{ width: "100%", maxWidth: 480, alignSelf: "center", gap: spacing.md }}>
            <View style={{ gap: 4 }}>
              <Text accessibilityRole="header" style={type.titleLg}>Set a new password</Text>
              <Text style={type.bodyMuted}>
                You signed in with a temporary password. Choose a new one to continue —
                this only takes a moment.
              </Text>
            </View>
            <TextField
              testID="force-change-current"
              label="Temporary password"
              value={current}
              onChangeText={setCurrent}
              secureTextEntry
              autoCapitalize="none"
              editable={!saving}
              placeholder="The temporary password you signed in with"
            />
            <TextField
              testID="force-change-new"
              label="New password"
              value={next}
              onChangeText={setNext}
              secureTextEntry
              autoCapitalize="none"
              editable={!saving}
              placeholder="At least 12 characters"
            />
            <TextField
              testID="force-change-confirm"
              label="Confirm new password"
              value={confirm}
              onChangeText={setConfirm}
              secureTextEntry
              autoCapitalize="none"
              editable={!saving}
              placeholder="Re-enter new password"
              error={error}
            />
            <Button testID="force-change-submit" label={saving ? "Saving…" : "Set password & continue"} icon="lock" loading={saving} onPress={submit} fullWidth />
            <Button disabled={saving} testID="force-change-signout" label="Sign out instead" variant="ghost" onPress={() => logout()} fullWidth />
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
