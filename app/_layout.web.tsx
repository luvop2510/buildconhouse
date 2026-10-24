import { Stack } from "expo-router";
import { useEffect } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { InitialAccountRouteProvider } from "@/src/state/initial-account-route";
import { AuthProvider } from "@/src/state/auth";
import { AuthGate } from "@/src/components/AuthGate";
import { BackendServerStatus } from "@/src/components/BackendServerStatus";
import { colors } from "@/src/theme/tokens";
import { ToastHost } from "@/src/components/Toast";
import { initPerformanceSignals, initSentry } from "@/src/lib/monitoring";
import { useAppFonts } from "@/src/hooks/use-app-fonts";
import { reloadAppFonts } from "@/src/hooks/app-font-recovery.web";
import { useKeyboardViewport } from "@/src/hooks/use-keyboard-viewport";

/**
 * Browser-only root shell.
 *
 * The native root needs splash screen coordination, native safe areas and the
 * gesture-handler root.  React Native Web does not: importing those modules at
 * the entry point made their native implementation part of every initial web
 * route, including the login page.  Keep this deliberately small; route-level
 * screens load their own platform integrations when a user actually opens them.
 */

export default function RootLayout() {
  useKeyboardViewport();
  const [loaded, error] = useAppFonts();
  useEffect(() => {
    // Let the pre-Expo recovery bootstrap know client startup succeeded. The
    // hydrated tree can still match the server's static loading snapshot while
    // fonts or the backend are finishing, so DOM changes alone are insufficient.
    (window as Window & { __FORGE_APP_MOUNTED__?: boolean }).__FORGE_APP_MOUNTED__ = true;
    window.dispatchEvent(new Event("forge:app-mounted"));
    initSentry();
    initPerformanceSignals();
  }, []);
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <InitialAccountRouteProvider>
        <AuthProvider>
          {error ? <View testID="app-font-error" style={{ flex: 1, padding: 24, alignItems: "center", justifyContent: "center", gap: 16 }}>
            <Text accessibilityRole="header" style={{ fontSize: 22, fontWeight: "600", color: colors.onSurface }}>Unable to load the workspace</Text>
            <Text style={{ color: colors.onSurfaceSecondary, textAlign: "center", maxWidth: 420 }}>Check your connection and try again.</Text>
            <Pressable accessibilityRole="button" onPress={reloadAppFonts} style={{ backgroundColor: colors.brand, borderRadius: 8, paddingHorizontal: 24, paddingVertical: 14 }}>
              <Text style={{ color: colors.onBrand, fontWeight: "600" }}>Try again</Text>
            </Pressable>
          </View> : !loaded ? <View testID="app-font-loading" style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            <BackendServerStatus detail="Preparing the sign-in screen." />
          </View> : <>
            <AuthGate>
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.surface } }} />
            </AuthGate>
            <ToastHost />
          </>}
        </AuthProvider>
      </InitialAccountRouteProvider>
    </View>
  );
}
