import { useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";

import type { HealthScore } from "@/src/api/executive";
import { Card } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

const BAND_TONE: Record<string, { fg: string; bg: string }> = {
  Healthy: { fg: colors.success, bg: colors.successBg },
  Watch: { fg: colors.warning, bg: colors.warningBg },
  "At risk": { fg: colors.error, bg: colors.errorBg },
};

/**
 * The first thing the owner sees (spec §8): one number, a band, and how many
 * signals it is based on.
 *
 * Everything about it is auditable — tapping expands every component with its
 * raw value, the rule that produced it, its weight, and a link to the
 * workspace that would improve it. A score the owner cannot interrogate is a
 * score the owner will not trust.
 *
 * When no signal can be measured the card says so rather than rendering 0,
 * which would read as "the business is failing".
 */
export function HealthScoreCard({ health, testID }: { health: HealthScore; testID?: string }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const tone = health.band ? BAND_TONE[health.band] : { fg: colors.onSurfaceMuted, bg: colors.surfaceTertiary };

  return (
    <Card testID={testID} variant="outlined" padding={spacing.xl}>
      <Pressable
        accessibilityLabel={`Business health ${health.score ?? "unavailable"}. ${expanded ? "Collapse" : "Expand"} components`}
        onPress={() => setExpanded((v) => !v)}
        style={{ minHeight: 44, justifyContent: "center", gap: spacing.sm }}
        testID={testID ? `${testID}-toggle` : undefined}
      >
        <Text style={type.captionStrong}>BUSINESS HEALTH</Text>

        {health.score === null ? (
          <Text style={[type.titleMd, { color: colors.onSurfaceMuted }]}>Not enough data to score yet</Text>
        ) : (
          <View style={{ flexDirection: "row", alignItems: "flex-end", gap: spacing.md, flexWrap: "wrap" }}>
            <Text
              style={{
                fontSize: 52,
                lineHeight: 58,
                fontFamily: type.displayMd.fontFamily,
                fontWeight: "700",
                color: colors.onSurface,
                letterSpacing: -1.5,
                fontVariant: ["tabular-nums"],
              }}
            >
              {health.score}
            </Text>
            <Text style={[type.bodyMuted, { paddingBottom: 10 }]}>/ 100</Text>
            <View
              style={{
                backgroundColor: tone.bg,
                paddingHorizontal: spacing.md,
                paddingVertical: 4,
                borderRadius: radius.pill,
                marginBottom: 12,
              }}
            >
              <Text style={[type.captionStrong, { color: tone.fg }]}>{health.band}</Text>
            </View>
          </View>
        )}

        <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
          {health.missing_signal_note || `Based on all ${health.total} signals`}
        </Text>
        <Text style={[type.caption, { color: colors.brand }]}>
          {expanded ? "Hide breakdown" : "How healthy is the business right now? · Show breakdown"}
        </Text>
      </Pressable>

      {expanded ? (
        <View style={{ gap: spacing.sm, marginTop: spacing.md }}>
          {health.components.map((component) => (
            <Pressable
              key={component.key}
              accessibilityLabel={`${component.label}, open the workspace that improves it`}
              onPress={() => router.push(component.destination as never)}
              style={{
                minHeight: 44,
                justifyContent: "center",
                paddingVertical: spacing.sm,
                borderTopWidth: 1,
                borderTopColor: colors.border,
                gap: 2,
              }}
              testID={`health-component-${component.key}`}
            >
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md }}>
                <Text style={[type.bodyStrong, { flex: 1, minWidth: 0 }]} numberOfLines={1}>
                  {component.label}
                </Text>
                <Text
                  style={[
                    type.bodyStrong,
                    { color: component.available ? colors.onSurface : colors.onSurfaceMuted, fontVariant: ["tabular-nums"] },
                  ]}
                >
                  {component.available ? `${component.value}` : "No data"}
                </Text>
              </View>
              <View style={{ flexDirection: "row", justifyContent: "space-between", gap: spacing.md }}>
                <Text style={[type.caption, { flex: 1, minWidth: 0, color: colors.onSurfaceMuted }]} numberOfLines={2}>
                  {component.rule}
                </Text>
                <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>weight {component.weight}</Text>
              </View>
            </Pressable>
          ))}
        </View>
      ) : null}
    </Card>
  );
}
