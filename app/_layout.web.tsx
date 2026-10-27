import { Stack } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";
import { SpeedInsights } from "@vercel/speed-insights/react";

import { InitialAccountRouteProvider } from "@/src/state/initial-account-route";
import { AuthProvider } from "@/src/state/auth";
import { AuthGate } from "@/src/components/AuthGate";
import { colors } from "@/src/theme/tokens";
import { ToastHost } from "@/src/components/Toast";
import { initPerformanceSignals, initSentry } from "@/src/lib/monitoring";
import { useAppFonts } from "@/src/hooks/use-app-fonts";
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
  useEffect(() => { initSentry(); initPerformanceSignals(); }, []);
  if (!loaded && !error) return null;
  return (
    <View style={{ flex: 1, backgroundColor: colors.surface }}>
      <InitialAccountRouteProvider>
        <AuthProvider>
          <AuthGate>
            <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.surface } }} />
          </AuthGate>
          <ToastHost />
        </AuthProvider>
      </InitialAccountRouteProvider>
      <SpeedInsights />
    </View>
  );
}
