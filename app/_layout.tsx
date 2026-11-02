import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useAppFonts } from "@/src/hooks/use-app-fonts";
import { useKeyboardViewport } from "@/src/hooks/use-keyboard-viewport";
import { AuthProvider } from "@/src/state/auth";
import { AuthGate } from "@/src/components/AuthGate";
import { colors } from "@/src/theme/tokens";
import { ToastHost } from "@/src/components/Toast";
import { initPerformanceSignals, initSentry } from "@/src/lib/monitoring";
import { subscribeDeletionProgress } from "@/src/api/client";
import { Text } from "@/src/components/AppText";

// Production monitoring — complete no-op unless EXPO_PUBLIC_SENTRY_DSN is set
// (see src/lib/monitoring.ts). Safe to call unconditionally at module load.
initSentry();
initPerformanceSignals();

SplashScreen.preventAutoHideAsync();


export default function RootLayout() {
  useKeyboardViewport();
  const [deleting, setDeleting] = useState(0);
  useEffect(() => subscribeDeletionProgress(setDeleting), []);
  const [loaded, error] = useAppFonts();
  useEffect(() => {
    if (loaded || error) SplashScreen.hideAsync();
  }, [loaded, error]);
  if (!loaded && !error) return null;

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: colors.surface }}>
          <StatusBar style="dark" />
          <AuthProvider>
            <AuthGate>
              <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.surface } }} />
            </AuthGate>
            <ToastHost />
            {deleting > 0 ? <View pointerEvents="none" accessibilityRole="progressbar" accessibilityLabel="Deletion in progress" accessibilityState={{ busy: true }} testID="global-delete-progress" style={{ position: "absolute", top: 12, alignSelf: "center", flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 14, borderRadius: 10, backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border, zIndex: 1000 }}><ActivityIndicator size="small" color={colors.brand} /><Text style={{ color: colors.onSurface }}>Deleting…</Text></View> : null}
          </AuthProvider>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
