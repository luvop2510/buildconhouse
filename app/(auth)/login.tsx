// ─────────────────────────────────────────────────────────────────────────────
// Authentication — one image, one form, one button.
// ─────────────────────────────────────────────────────────────────────────────
import React, { createElement, useEffect, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { NavigationLink } from "@/src/design/NavigationLink";

import { Button, Field, IconButton, Input, Txt } from "@/src/design/components";
import { NavigationTabs } from "@/src/design/NavigationTabs";
import { BuildConLogo } from "@/src/design/BrandLogo";
import { useBp } from "@/src/design/responsive";
import { color, font, space } from "@/src/design/tokens";
import { useAuth } from "@/src/state/auth";


type Mode = "staff" | "customer";

export default function Login() {
  const { loginStaff, loginCustomer } = useAuth();
  const { isPhone, height } = useBp();
  const compactPhone = isPhone && height < 700;
  const insets = useSafeAreaInsets();

  const [mode, setMode] = useState<Mode>("staff");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [factor, setFactor] = useState("");
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The web export renders before React attaches input handlers. Accepting
  // text in that interval loses it when hydration replaces the static form.
  const [interactive, setInteractive] = useState(Platform.OS !== "web");
  useEffect(() => { setInteractive(true); }, []);

  const submit = async () => {
    if (busy || !interactive) return;
    if (!email.trim() || !password) { setError(mode === "staff" ? "Enter your email or username and password." : "Enter your email and password."); return; }
    Keyboard.dismiss();
    setBusy(true); setError(null);
    try {
      if (mode === "staff") {
        await loginStaff(email.trim(), password, mfaRequired ? (useRecovery ? { recovery_code: factor.trim() } : { mfa_code: factor.trim() }) : undefined);
      } else {
        await loginCustomer(email.trim(), password);
      }
      // Navigation is intentionally NOT done here — AuthGate (app/_layout.tsx)
      // reacts to the `kind` state change from loginStaff/loginCustomer above
      // and performs the redirect exactly once. Calling router.replace() here
      // AS WELL used to race against AuthGate's own replace() to the same
      // destination, and on web that double-navigation could leave the app
      // stuck on /login with a valid session already in memory.
    } catch (e: any) {
      if (e?.detail === "mfa_required" || e?.message === "mfa_required") { setMfaRequired(true); setBusy(false); return; }
      setError(e?.message === "Invalid credentials" ? "Those sign-in details don't match." : e?.message || "Sign-in failed. Try again.");
      setBusy(false);
    }
  };

  const formContent = (
    <View style={{ width: "100%", maxWidth: 384, alignSelf: "center", gap: compactPhone ? space.x3 : space.x5 }}>
      <View style={{ gap: 8 }}>
        <BuildConLogo height={36} style={{ marginBottom: 16 }} />
        <Txt v="display" style={isPhone ? { fontSize: 30, lineHeight: 38 } : undefined}>
          {mode === "staff" ? "Staff sign-in" : "Customer sign-in"}
        </Txt>
        <Txt v="bodyMid">
          {mode === "staff" ? "Manage quotations, orders and customer relationships." : "Review quotations shared by your BuildCon House team."}
        </Txt>
      </View>

      <NavigationTabs value={mode} options={[{ value: "staff", label: "Staff workspace" }, { value: "customer", label: "Customer portal" }]}
        onChange={(option) => { setMode(option); setError(null); setPassword(""); setMfaRequired(false); setFactor(""); }} disabled={busy || !interactive} fullWidth testID="login-mode" />

      <View style={{ gap: compactPhone ? space.x3 : space.x4 }}>
        <Field label={mode === "staff" ? "Email or username" : "Email"}>
          <Input
            testID="login-email"
            value={email}
            onChangeText={(v) => { setEmail(v); setError(null); setMfaRequired(false); setFactor(""); }}
            placeholder={mode === "staff" ? "Email or username" : "you@company.com"}
            keyboardType={mode === "staff" ? "default" : "email-address"}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete={mode === "staff" ? "username" : "email"}
            returnKeyType="next"
            editable={!busy && interactive}
          />
        </Field>
        <Field label="Password" error={error}>
          <Input
            testID="login-password"
            value={password}
            onChangeText={(v) => { setPassword(v); setError(null); }}
            placeholder="••••••••"
            secureTextEntry={!showPw}
            autoCapitalize="none"
            autoComplete="password"
            returnKeyType="go"
            editable={!busy && interactive}
            onSubmitEditing={submit}
            invalid={!!error}
            right={<IconButton icon={showPw ? "eye-off" : "eye"} size={30} iconSize={15} tone="soft" onPress={() => setShowPw((v) => !v)} label={showPw ? "Hide password" : "Show password"} />}
          />
        </Field>
        {mode === "staff" && mfaRequired ? <View style={{ gap: space.x3 }}>
          <Txt v="bodyMid">Enter a code from your authenticator app to finish signing in.</Txt>
          <Field label={useRecovery ? "Recovery code" : "Authenticator code"}>
            <Input testID="login-mfa-code" value={factor} onChangeText={setFactor} autoCapitalize="none" autoCorrect={false}
              keyboardType={useRecovery ? "default" : "number-pad"} maxLength={useRecovery ? 40 : 6}
              placeholder={useRecovery ? "Saved recovery code" : "6-digit code"} editable={!busy} onSubmitEditing={submit} />
          </Field>
          <Button testID="login-mfa-recovery" label={useRecovery ? "Use authenticator code" : "Use a recovery code"}
            onPress={() => { setUseRecovery(!useRecovery); setFactor(""); setError(null); }} disabled={busy} />
        </View> : null}
        <Button testID="login-submit" label="Sign in" size="lg" full onPress={submit} loading={busy} disabled={!interactive} />
      </View>

      <View style={{ flexDirection: "row", justifyContent: "center", gap: space.x4 }}>
        <NavigationLink href="/privacy" accessibilityRole="link" style={{ minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" }} testID="login-privacy-link" hitSlop={8}>
          <Text style={{ fontFamily: font.regular, fontSize: 12, color: color.inkSoft }}>Privacy</Text>
        </NavigationLink>
        <NavigationLink href="/terms" accessibilityRole="link" style={{ minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center" }} testID="login-terms-link" hitSlop={8}>
          <Text style={{ fontFamily: font.regular, fontSize: 12, color: color.inkSoft }}>Terms</Text>
        </NavigationLink>
      </View>
    </View>
  );

  const form = Platform.OS === "web" ? createElement("form", {
    "aria-label": mode === "staff" ? "Staff sign-in" : "Customer sign-in",
    onSubmit: (event: React.FormEvent) => { event.preventDefault(); void submit(); },
    style: { width: "100%", margin: 0 },
  }, formContent, createElement("button", { type: "submit", tabIndex: -1, style: { display: "none" } }, "Sign in")) : formContent;

  return (
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1, backgroundColor: color.canvas }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ flexGrow: 1, paddingHorizontal: isPhone ? 24 : 48, paddingTop: Math.max(insets.top + 24, 40), paddingBottom: Math.max(insets.bottom + 24, 40), justifyContent: "center" }}>
        <View style={{ width: "100%", maxWidth: 1040, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 72 }}>
          {!isPhone ? <View style={{ flex: 1, gap: space.x5 }}>
            <Text style={{ fontFamily: font.medium, fontSize: 12, letterSpacing: 1.4, color: color.inkMid }}>BUILDCON HOUSE</Text>
            <Txt v="display" style={{ fontSize: 44, lineHeight: 54 }}>Every detail.
Every delivery.</Txt>
            <Txt v="bodyMid">One workspace for the people, products and documents behind each customer project.</Txt>
            <View style={{ borderTopWidth: 1, borderTopColor: color.line, paddingTop: space.x5, gap: space.x3 }}>
              <Txt v="bodyMid">Sanitary · Tiles · Kitchen · Furniture</Txt>
            </View>
          </View> : null}
          <View style={{ flex: 1, minWidth: 0 }}>{form}</View>
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
