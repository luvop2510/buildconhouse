import * as Clipboard from "expo-clipboard";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import { api } from "@/src/api/client";
import { SettingsPage } from "@/src/components/settings/SettingsPage";
import { Button, Card, TextField } from "@/src/components/ui";
import { spacing, type } from "@/src/theme/tokens";

type Status = { enabled: boolean; recovery_codes_remaining: number };
type Enrollment = { secret: string; uri: string; expires_in: number };
export default function SettingsMFA() {
  const router = useRouter();
  const [status, setStatus] = useState<Status | null>(null);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [password, setPassword] = useState("");
  const [factor, setFactor] = useState("");
  const [recovery, setRecovery] = useState(false);
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const load = () => api.get<Status>("/auth/mfa/status").then(setStatus);
  useEffect(() => { let active = true; api.get<Status>("/auth/mfa/status").then(value => { if (active) setStatus(value); }).catch(() => { if (active) setError("Could not load MFA status. Reopen this page to retry."); }); return () => { active = false; }; }, []);
  const act = async (action: "enroll" | "confirm" | "recovery" | "disable") => {
    if (busy) return;
    setBusy(true); setError(null); setCopied(false);
    try {
      const body = { current_password: password, ...(recovery && !enrollment ? { recovery_code: factor.trim() } : { mfa_code: factor.trim() }) };
      if (action === "enroll") setEnrollment(await api.post<Enrollment>("/auth/mfa/enroll", body));
      else {
        const result = await api.post<{ recovery_codes?: string[] }>(`/auth/mfa/${action}`, body);
        setCodes(result.recovery_codes || []); setEnrollment(null); setPassword(""); setFactor(""); setRecovery(false);
        await load();
      }
    } catch (e: unknown) { setError(e instanceof Error ? e.message : "Could not update MFA. Try again."); }
    finally { setBusy(false); }
  };
  const copy = async (text: string) => { try { await Clipboard.setStringAsync(text); setCopied(true); } catch { setError("Copy failed. Select and save the displayed text instead."); } };
  return <SettingsPage title="Authenticator MFA" back={() => router.back()}>
    <View style={{ gap: spacing.lg }}>
      <Card style={{ gap: spacing.md }}>
        <Text style={type.body}>MFA requires your password and an authenticator or recovery code at each sign-in after enrollment. Owner and admin accounts follow this requirement once enrolled.</Text>
        <Text style={type.bodyStrong}>{status ? status.enabled ? `Enabled · ${status.recovery_codes_remaining} recovery codes remaining` : "Not enrolled" : "Loading MFA status…"}</Text>
        {codes.length ? <View style={{ gap: spacing.md }}>
          <Text style={type.bodyStrong}>Save these recovery codes now</Text>
          <Text style={type.body}>Each code can be used once. Keep them in a password manager or another private location. These codes are shown only once; generating new codes invalidates the previous set.</Text>
          <Text selectable testID="mfa-recovery-codes" style={type.body}>{codes.join("\n")}</Text>
          <Button label={copied ? "Copied" : "Copy recovery codes"} onPress={() => copy(codes.join("\n"))} />
          <Button label="I saved my recovery codes" onPress={() => { setCodes([]); setCopied(false); }} />
        </View> : status ? <>
          <TextField testID="mfa-password" label="Current password" secureTextEntry value={password} onChangeText={setPassword} autoCapitalize="none" />
          {enrollment ? <View style={{ gap: spacing.md }}>
            <Text style={type.body}>Add a time-based account in your authenticator app using this setup key. Setup expires in 10 minutes. MFA becomes active after you verify its code.</Text>
            <Text selectable testID="mfa-setup-key" style={type.body}>{enrollment.secret}</Text>
            <Button label="Copy setup key" onPress={() => copy(enrollment.secret)} />
            <Text selectable style={type.caption}>{enrollment.uri}</Text>
            <TextField testID="mfa-code" label="Authenticator code" value={factor} onChangeText={setFactor} keyboardType="number-pad" maxLength={6} />
            <Button testID="mfa-confirm" label="Verify and enable MFA" loading={busy} onPress={() => act("confirm")} />
            <Button label="Cancel setup" disabled={busy} onPress={() => { setEnrollment(null); setFactor(""); setPassword(""); }} />
          </View> : status.enabled ? <>
            <TextField testID="mfa-code" label={recovery ? "Recovery code" : "Authenticator code"} value={factor} onChangeText={setFactor} autoCapitalize="none" keyboardType={recovery ? "default" : "number-pad"} maxLength={recovery ? 40 : 6} />
            <Button label={recovery ? "Use authenticator code" : "Use a recovery code"} disabled={busy} onPress={() => { setRecovery(!recovery); setFactor(""); }} />
            <Text style={type.caption}>Changes sign out your other devices. Wait for a fresh authenticator code if you just used one to sign in.</Text>
            <Button testID="mfa-regenerate" label="Replace recovery codes" loading={busy} onPress={() => act("recovery")} />
            <Button testID="mfa-disable" label="Disable MFA" loading={busy} onPress={() => act("disable")} />
          </> : <Button testID="mfa-enroll" label="Set up authenticator" loading={busy} onPress={() => act("enroll")} />}
        </> : null}
        {error ? <Text accessibilityRole="alert" style={type.body}>{error}</Text> : null}
      </Card>
    </View>
  </SettingsPage>;
}
