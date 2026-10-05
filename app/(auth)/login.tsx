// ─────────────────────────────────────────────────────────────────────────────
// Authentication — one image, one form, one button.
// ─────────────────────────────────────────────────────────────────────────────
import React, { createElement, useState } from "react";
import { Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";

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
  const router = useRouter();

  const [mode, setMode] = useState<Mode>("staff");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy) return;
    if (!email.trim() || !password) { setError("Enter your email and password."); return; }
    Keyboard.dismiss();
    setBusy(true); setError(null);
    try {
      if (mode === "staff") {
        await loginStaff(email.trim(), password);
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
      setError(e?.message === "Invalid credentials" ? "That email and password don't match." : e?.message || "Sign-in failed. Try again.");
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
        onChange={(option) => { setMode(option); setError(null); setPassword(""); }} disabled={busy} fullWidth testID="login-mode" />

      <View style={{ gap: compactPhone ? space.x3 : space.x4 }}>
        <Field label="Email">
          <Input
            testID="login-email"
            value={email}
            onChangeText={(v) => { setEmail(v); setError(null); }}
            placeholder="you@company.com"
            keyboardType="email-address"
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="email"
            returnKeyType="next"
            editable={!busy}
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
            editable={!busy}
            onSubmitEditing={submit}
            invalid={!!error}
            right={<IconButton icon={showPw ? "eye-off" : "eye"} size={30} iconSize={15} tone="soft" onPress={() => setShowPw((v) => !v)} label={showPw ? "Hide password" : "Show password"} />}
          />
        </Field>
        <Button testID="login-submit" label="Sign in" size="lg" full onPress={submit} loading={busy} />
      </View>

      <View style={{ flexDirection: "row", justifyContent: "center", gap: space.x4 }}>
        <Pressable accessibilityRole="link" style={{ minHeight: 44, justifyContent: "center" }} testID="login-privacy-link" onPress={() => router.push("/privacy")} hitSlop={8}>
          <Text style={{ fontFamily: font.regular, fontSize: 12, color: color.inkSoft }}>Privacy</Text>
        </Pressable>
        <Pressable accessibilityRole="link" style={{ minHeight: 44, justifyContent: "center" }} testID="login-terms-link" onPress={() => router.push("/terms")} hitSlop={8}>
          <Text style={{ fontFamily: font.regular, fontSize: 12, color: color.inkSoft }}>Terms</Text>
        </Pressable>
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
