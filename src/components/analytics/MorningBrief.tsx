import { View } from "react-native";
import { Text } from "@/src/components/AppText";

import type { MorningBrief as MorningBriefPayload } from "@/src/api/executive";
import { Card } from "@/src/components/ui";
import { fmtMoneyCompact } from "@/src/design/tokens";
import { colors, spacing, type } from "@/src/theme/tokens";

import { ActionRow } from "./ActionRow";

/**
 * The deterministic daily digest (spec §11). No model is involved — it is a
 * template filled from the same services every other card uses, which is
 * precisely why it can be trusted.
 *
 * Two rules it holds:
 *  - **Lines with no data are omitted**, not shown as zero. A day with no
 *    collections says nothing about collections rather than claiming ₹0.
 *  - **Recommended actions are the top three Attention/Opportunity rows by ₹**,
 *    rendered with the same ActionRow the cards below use, so the brief can
 *    never contradict them.
 */
export function MorningBrief({ brief, testID }: { brief: MorningBriefPayload; testID?: string }) {
  const { yesterday } = brief;

  const lines: { label: string; value: string }[] = [];
  if (yesterday.revenue > 0) lines.push({ label: "Revenue", value: fmtMoneyCompact(yesterday.revenue) });
  if (yesterday.orders > 0) lines.push({ label: "Orders", value: String(yesterday.orders) });
  if (yesterday.collections > 0) lines.push({ label: "Collections", value: fmtMoneyCompact(yesterday.collections) });

  return (
    <Card testID={testID} variant="flat" padding={spacing.xl}>
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: spacing.xs }}>
          <Text style={type.titleMd}>{brief.greeting}</Text>
          <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
            What happened yesterday and what to do today
          </Text>
        </View>

        <View style={{ gap: spacing.sm }}>
          <Text style={type.captionStrong}>{yesterday.label.toUpperCase()}</Text>
          {lines.length ? (
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xl }}>
              {lines.map((line) => (
                <View key={line.label} style={{ gap: 2 }}>
                  <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>{line.label}</Text>
                  <Text style={[type.titleSm, { fontVariant: ["tabular-nums"] }]}>{line.value}</Text>
                </View>
              ))}
            </View>
          ) : (
            <Text style={[type.body, { color: colors.onSurfaceMuted }]}>
              No confirmed activity yesterday.
            </Text>
          )}
        </View>

        {brief.recommended_actions.length ? (
          <View style={{ gap: spacing.sm }}>
            <Text style={type.captionStrong}>RECOMMENDED ACTIONS</Text>
            <View style={{ gap: spacing.sm }}>
              {brief.recommended_actions.map((row, index) => (
                <ActionRow key={`${row.rule}-${index}`} row={row} compact testID={`brief-action-${index}`} />
              ))}
            </View>
          </View>
        ) : null}
      </View>
    </Card>
  );
}
