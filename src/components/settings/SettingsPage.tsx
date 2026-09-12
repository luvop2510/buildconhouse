import type { ComponentProps } from "react";
import { useRouter } from "expo-router";
import { Pressable, Text, View } from "react-native";
import { AdminPage } from "@/src/components/AdminPage";
import { colors, spacing, type } from "@/src/theme/tokens";

/** Consistent wayfinding and reading width for every workspace setting. */
export function SettingsPage({ children, contentStyle, ...props }: ComponentProps<typeof AdminPage>) {
  const router = useRouter();
  return <AdminPage {...props} contentStyle={{ width: "100%", maxWidth: 1040, alignSelf: "center", ...contentStyle }}>
    <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.sm }}>
      <Pressable accessibilityRole="link" onPress={() => router.push("/(admin)/settings")} style={{ minHeight: 44, justifyContent: "center" }}>
        <Text style={[type.bodyStrong, { color: colors.brand }]}>Settings</Text>
      </Pressable>
      <Text style={type.caption}>/</Text><Text style={type.caption}>{props.title}</Text>
    </View>
    {children}
  </AdminPage>;
}
