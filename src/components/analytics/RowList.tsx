import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";

import type { ExecutiveRow } from "@/src/api/executive";
import { Card } from "@/src/components/ui";
import { colors, spacing, type } from "@/src/theme/tokens";

import { ActionRow } from "./ActionRow";

/**
 * The Attention Center (§9) and Opportunity Center (§10).
 *
 * One component, not two: they are the same ranked list of the same row shape
 * differing only in copy and accent — building them separately would be the
 * duplication the architecture exists to prevent. The rules that fill them are
 * genuinely different and live in two separate backend modules; the rendering
 * is not.
 *
 * Attention shows a calm confirmation when nothing is wrong. It never shows a
 * "you're doing great" card while real problems exist, because the emptiness
 * IS the confirmation.
 */
export function RowList({
  kind,
  rows,
  total,
  testID,
  floorId,
}: {
  kind: "attention" | "opportunity";
  rows: ExecutiveRow[];
  total: number;
  testID?: string;
  floorId?: string;
}) {
  const router = useRouter();
  const isAttention = kind === "attention";
  const title = isAttention ? "Needs attention" : "Opportunities";
  const question = isAttention ? "What is today's biggest risk?" : "Where should we grow?";
  const emptyCopy = isAttention
    ? "Nothing needs attention right now."
    : "No new openings in this period.";
  const hidden = Math.max(0, total - rows.length);

  return (
    <Card testID={testID} variant="flat" padding={spacing.xl}>
      <View style={{ gap: spacing.lg }}>
        <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.md }}>
          <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
            <Text style={type.titleSm}>{title}</Text>
            <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>{question}</Text>
          </View>
          {total > 0 ? (
            <Text style={[type.captionStrong, { color: colors.onSurfaceMuted, fontVariant: ["tabular-nums"] }]}>
              {total}
            </Text>
          ) : null}
        </View>

        {rows.length ? (
          <View style={{ gap: spacing.sm }}>
            {rows.map((row, index) => (
              <ActionRow key={`${row.rule}-${index}`} row={row} testID={`${testID}-row-${index}`} />
            ))}
          </View>
        ) : (
          <Text style={[type.body, { color: colors.onSurfaceMuted }]}>{emptyCopy}</Text>
        )}

        {hidden > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`See all ${total} in Today's Priorities`}
            onPress={() => router.push({ pathname: "/(admin)/sales-data/today", params: { floor_id: floorId || "all" } } as never)}
            style={{ minHeight: 44, justifyContent: "center" }}
            testID={`${testID}-see-all`}
          >
            <Text style={[type.captionStrong, { color: colors.brand }]}>
              See all {total} in Today&apos;s Priorities →
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Card>
  );
}
