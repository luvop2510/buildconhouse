import { Stack, useRootNavigationState, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { View } from "react-native";

import { InitialAccountRouteProvider } from "@/src/state/initial-account-route";
import { AuthProvider, useAuth } from "@/src/state/auth";
import { staffLandingPath } from "@/src/access-profiles";
import { colors } from "@/src/theme/tokens";
import { ToastHost } from "@/src/components/Toast";
import { initPerformanceSignals, initSentry } from "@/src/lib/monitoring";
import { useAppFonts } from "@/src/hooks/use-app-fonts";

/**
 * Browser-only root shell.
 *
 * The native root needs splash screen coordination, native safe areas and the
 * gesture-handler root.  React Native Web does not: importing those modules at
 * the entry point made their native implementation part of every initial web
 * route, including the login page.  Keep this deliberately small; route-level
 * screens load their own platform integrations when a user actually opens them.
 */
function AuthGate({ children }: { children: React.ReactNode }) {
  const { loading, kind, staff, customer } = useAuth();
  const segments = useSegments() as string[];
  const router = useRouter();
  const navigationState = useRootNavigationState();
  const isNavigationReady = navigationState?.key !== undefined;

  useEffect(() => {
    if (loading || !isNavigationReady) return;
    if (segments[0] === "privacy" || segments[0] === "terms") return;

    const inAuth = segments[0] === "(auth)";
    const inAdmin = segments[0] === "(admin)";
    const inCustomer = segments[0] === "(customer)";
    const onForceChange = inAuth && segments[1] === "set-new-password";
    const mustChangePassword =
      (kind === "staff" && !!staff?.must_change_password) ||
      (kind === "customer" && !!customer?.must_change_password);

    if (kind && mustChangePassword) {
      if (!onForceChange) router.replace("/(auth)/set-new-password");
      return;
    }
    if (kind && onForceChange) {
      router.replace(kind === "staff" ? staffLandingPath(staff?.access_profile, staff?.access_grants) as any : "/(customer)/home");
      return;
    }
    if (!kind && !inAuth) {
      router.replace("/(auth)/login");
    } else if (kind === "staff" && !inAdmin) {
      router.replace(staffLandingPath(staff?.access_profile, staff?.access_grants) as any);
    } else if (kind === "customer" && !inCustomer) {
      router.replace("/(customer)/home");
    }
  }, [kind, loading, isNavigationReady, segments, router, staff, customer]);

  return <>{children}</>;
}

export default function RootLayout() {
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
    </View>
  );
}
