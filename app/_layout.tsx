import { Stack, useRootNavigationState, useRouter, useSegments } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import { StatusBar } from "expo-status-bar";
import { useEffect } from "react";
import { View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { useAppFonts } from "@/src/hooks/use-app-fonts";
import { AuthProvider, useAuth } from "@/src/state/auth";
import { staffLandingPath } from "@/src/access-profiles";
import { colors } from "@/src/theme/tokens";
import { ToastHost } from "@/src/components/Toast";
import { initPerformanceSignals, initSentry } from "@/src/lib/monitoring";

// Production monitoring — complete no-op unless EXPO_PUBLIC_SENTRY_DSN is set
// (see src/lib/monitoring.ts). Safe to call unconditionally at module load.
initSentry();
initPerformanceSignals();

SplashScreen.preventAutoHideAsync();

function AuthGate({ children }: { children: React.ReactNode }) {
  const { loading, kind, staff, customer } = useAuth();
  const segments = useSegments() as string[];
  const router = useRouter();
  const navigationState = useRootNavigationState();
  const isNavigationReady = navigationState?.key !== undefined;

  useEffect(() => {
    if (loading || !isNavigationReady) return;
    // Public routes, reachable with or without a session — App Store
    // Connect / Google Play Console both require hosted privacy-policy and
    // terms-of-service URLs a reviewer (or anyone) can open with no
    // account. See app/privacy.tsx and app/terms.tsx.
    if (segments[0] === "privacy" || segments[0] === "terms") return;
    const inAuth = segments[0] === "(auth)";
    const inAdmin = segments[0] === "(admin)";
    const inCustomer = segments[0] === "(customer)";
    const onForceChange = inAuth && segments[1] === "set-new-password";

    // Staff credentials are permanent and owner-managed. Temporary customer
    // portal invites keep their separate first-sign-in password policy.
    const mustChangePassword =
      (kind === "customer" && !!customer?.must_change_password);

    if (kind && mustChangePassword) {
      // Still must change password: redirect to the force-change screen if
      // not already there, otherwise do nothing and let the user finish it.
      // Bug fixed here: this used to be `if (... && !onForceChange)` with no
      // matching branch for "must change AND already on that screen" — that
      // case fell through to the generic staff/customer routing below, which
      // bounced straight back to /(admin)/dashboard, which re-triggered this
      // same redirect next render — an infinite replace() loop that crashed
      // the app with "Maximum update depth exceeded" for every account with
      // a temporary password (i.e. every staff account after a credential
      // rotation) the moment they reached this screen.
      if (!onForceChange) router.replace("/(auth)/set-new-password");
      return;
    }
    if (kind && onForceChange) {
      // Just finished the forced change (mustChangePassword is now false,
      // otherwise the branch above would have returned) — fall through to
      // normal routing.
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
          </AuthProvider>
        </View>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
