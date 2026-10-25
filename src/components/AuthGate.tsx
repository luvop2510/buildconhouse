import { useRootNavigationState, useRouter, useSegments } from "expo-router";
import { useEffect } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { useAuth } from "@/src/state/auth";
import { staffLandingPath } from "@/src/access-profiles";
import { colors } from "@/src/theme/tokens";
import { BackendServerStatus } from "@/src/components/BackendServerStatus";

export function AuthGate({ children }: { children: React.ReactNode }) {
  const { loading, sessionError, retrySession, kind, staff, customer } = useAuth();
  const segments = useSegments() as string[];
  const router = useRouter();
  const navigationState = useRootNavigationState();
  const isNavigationReady = navigationState?.key !== undefined;

  useEffect(() => {
    if (loading || sessionError || !isNavigationReady) return;
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
  }, [kind, loading, sessionError, isNavigationReady, segments, router, staff, customer]);

  const publicRoute = segments[0] === "privacy" || segments[0] === "terms";
  // Login stays usable while an older identity request is pending.
  const starting = loading && !kind && segments[0] !== "(auth)";
  const recovering = (starting || !!sessionError) && !publicRoute;
  return <>
    <View accessibilityElementsHidden={recovering} importantForAccessibility={recovering ? "no-hide-descendants" : "auto"} style={{ flex: 1, display: recovering ? "none" : "flex" }}>{children}</View>
    {recovering ? <View testID={sessionError ? "session-recovery" : "backend-startup"} style={{ position: "absolute", inset: 0, backgroundColor: colors.surface, padding: 24, alignItems: "center", justifyContent: "center", gap: 16 }}>
      {starting ? <BackendServerStatus /> : <>
        <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 22, fontWeight: "600" }}>Reconnecting your session</Text>
        <Text style={{ color: colors.onSurfaceSecondary, maxWidth: 420, textAlign: "center" }}>{sessionError}</Text>
      </>}
      {loading ? (!starting ? <ActivityIndicator color={colors.brand} accessibilityLabel="Restoring your session" /> : null) : <Pressable testID="session-retry" accessibilityRole="button" onPress={() => void retrySession()} style={{ backgroundColor: colors.brand, paddingHorizontal: 24, paddingVertical: 14, borderRadius: 8 }}>
        <Text style={{ color: colors.onBrand, fontWeight: "600" }}>Try again</Text>
      </Pressable>}
    </View> : null}
  </>;
}
