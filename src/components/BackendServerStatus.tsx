import { useSyncExternalStore } from "react";
import { ActivityIndicator, Platform, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { getBackendStartupSnapshot, subscribeBackendStartup } from "@/src/lib/backend-startup";
import { colors } from "@/src/theme/tokens";

export function useBackendStartup() {
  return useSyncExternalStore(subscribeBackendStartup, getBackendStartupSnapshot, getBackendStartupSnapshot);
}

export function BackendServerStatus({ detail = "Checking your account access." }: { detail?: string }) {
  const { phase } = useBackendStartup();
  const native = Platform.OS !== "web";
  const awake = phase === "ready";
  const failed = phase === "unavailable";
  const title = native ? "Checking account access" : awake ? "Backend server is awake" : failed ? "Backend server is unavailable" : phase === "waking" ? "Starting backend server" : "Waiting for backend server";
  const copy = native || awake ? detail : failed ? "The server has not responded yet. Check your connection and try again." : "The server may be waking from standby. We’ll keep checking for up to one minute and continue as soon as it is awake.";
  return <View testID="backend-server-status" accessibilityLiveRegion="polite" style={{ alignItems: "center", gap: 16, width: "100%", maxWidth: 460 }}>
    {!failed ? <ActivityIndicator color={colors.brand} accessibilityLabel={native || awake ? detail : "Waiting for backend server to wake"} /> : null}
    <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 22, fontWeight: "600", textAlign: "center" }}>{title}</Text>
    <Text style={{ color: colors.onSurfaceSecondary, textAlign: "center" }}>{copy}</Text>
  </View>;
}
