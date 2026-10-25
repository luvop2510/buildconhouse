import { ActivityIndicator, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { colors } from "@/src/theme/tokens";

export function BackendServerStatus({ detail = "Checking your account access." }: { detail?: string }) {
  return <View testID="backend-server-status" accessibilityLiveRegion="polite" style={{ alignItems: "center", gap: 16, width: "100%", maxWidth: 460 }}>
    <ActivityIndicator color={colors.brand} accessibilityLabel={detail} />
    <Text accessibilityRole="header" style={{ color: colors.onSurface, fontSize: 22, fontWeight: "600", textAlign: "center" }}>Checking account access</Text>
    <Text style={{ color: colors.onSurfaceSecondary, textAlign: "center" }}>{detail}</Text>
  </View>;
}
