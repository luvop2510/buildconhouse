import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";

import type { MoneyBlocked } from "@/src/api/executive";
import { Card } from "@/src/components/ui";
import { fmtMoneyCompact } from "@/src/design/tokens";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

/**
 * "Where is money getting blocked?" (spec §7 Workspace 1).
 *
 * ₹-first: the total leads, and the three places money sits are shown as
 * shares of it. Every figure comes from the same rows the Attention rules
 * read, so this card and those rows can never disagree about what is stuck.
 */
export function MoneyBlockedCard({ blocked, testID }: { blocked: MoneyBlocked; testID?: string }) {
  const router = useRouter();
  const segments = [
    { key: "release", label: "Awaiting release", value: blocked.awaiting_release, tone: colors.warning },
    { key: "dispatch", label: "Awaiting dispatch", value: blocked.awaiting_dispatch, tone: colors.brand },
    { key: "payment", label: "Awaiting payment", value: blocked.awaiting_payment, tone: colors.error },
  ];
  const total = blocked.total || 1;

  return (
    <Card testID={testID} variant="outlined" padding={spacing.xl}>
      <Pressable
        accessibilityLabel="Money blocked, open Operations"
        onPress={() => router.push(blocked.destination as never)}
        style={{ gap: spacing.lg, minHeight: 44 }}
      >
        <View style={{ gap: 2 }}>
          <Text style={type.captionStrong}>MONEY BLOCKED</Text>
          <Text
            style={{
              fontSize: 34,
              lineHeight: 40,
              fontFamily: type.displayMd.fontFamily,
              fontWeight: "700",
              color: colors.onSurface,
              letterSpacing: -0.8,
              fontVariant: ["tabular-nums"],
            }}
          >
            {fmtMoneyCompact(blocked.total)}
          </Text>
          <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
            Where is money getting blocked?
          </Text>
        </View>

        {blocked.total > 0 ? (
          <View style={{ flexDirection: "row", height: 8, borderRadius: radius.pill, overflow: "hidden", gap: 2 }}>
            {segments.map((segment) => (
              <View
                key={segment.key}
                style={{
                  flexGrow: Math.max(segment.value / total, 0.001),
                  flexBasis: 0,
                  backgroundColor: segment.value > 0 ? segment.tone : colors.surfaceTertiary,
                }}
              />
            ))}
          </View>
        ) : null}

        <View style={{ gap: spacing.sm }}>
          {segments.map((segment) => (
            <View key={segment.key} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: segment.tone }} />
              <Text style={[type.caption, { flex: 1, minWidth: 0 }]} numberOfLines={1}>
                {segment.label}
              </Text>
              <Text style={[type.captionStrong, { fontVariant: ["tabular-nums"] }]}>
                {fmtMoneyCompact(segment.value)}
              </Text>
            </View>
          ))}
        </View>
      </Pressable>
    </Card>
  );
}
