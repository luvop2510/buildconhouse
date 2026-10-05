import { useRouter } from "expo-router";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";

import type { FeedEntry } from "@/src/api/executive";
import { Card } from "@/src/components/ui";
import { fmtMoneyCompact } from "@/src/design/tokens";
import { colors, spacing, type } from "@/src/theme/tokens";

const GROUP_LABEL: Record<FeedEntry["group"], string> = {
  today: "Today",
  yesterday: "Yesterday",
  this_week: "This week",
  older: "Earlier",
};

const GROUP_ORDER: FeedEntry["group"][] = ["today", "yesterday", "this_week", "older"];

function timeOf(created_at: string): string {
  const parsed = new Date(created_at);
  if (Number.isNaN(parsed.getTime())) return "";
  return parsed.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false });
}

/**
 * The live company-wide event stream (spec §13.1), grouped Today / Yesterday /
 * This week. Every entry links to the record the event happened to.
 *
 * The backend allowlist decides what appears here — 14 event types out of 49 —
 * so instrumentation added elsewhere in the app can never flood the owner's
 * view. Values are joined from the referenced record, never stored twice.
 */
export function ActivityFeed({ entries, testID }: { entries: FeedEntry[]; testID?: string }) {
  const router = useRouter();
  const grouped = GROUP_ORDER.map((group) => ({
    group,
    rows: entries.filter((entry) => entry.group === group),
  })).filter((section) => section.rows.length > 0);

  return (
    <Card testID={testID} variant="flat" padding={spacing.xl}>
      <View style={{ gap: spacing.lg }}>
        <View style={{ gap: 2 }}>
          <Text style={type.titleSm}>Activity</Text>
          <Text style={[type.caption, { color: colors.onSurfaceMuted }]}>
            What is happening in the business right now?
          </Text>
        </View>

        {grouped.length === 0 ? (
          <Text style={[type.body, { color: colors.onSurfaceMuted }]}>No recent activity.</Text>
        ) : (
          grouped.map((section) => (
            <View key={section.group} style={{ gap: spacing.sm }}>
              <Text style={type.captionStrong}>{GROUP_LABEL[section.group].toUpperCase()}</Text>
              {section.rows.map((entry) => (
                <Pressable
                  key={entry.id}
                  accessibilityLabel={`${entry.label}. Open record`}
                  onPress={() => router.push(entry.destination as never)}
                  testID={`${testID}-entry-${entry.id}`}
                  style={{
                    minHeight: 44,
                    flexDirection: "row",
                    alignItems: "center",
                    gap: spacing.md,
                    paddingVertical: spacing.xs,
                  }}
                >
                  <Text
                    style={[type.caption, { color: colors.onSurfaceMuted, width: 44, fontVariant: ["tabular-nums"] }]}
                  >
                    {timeOf(entry.created_at)}
                  </Text>
                  <View style={{ flex: 1, minWidth: 0, gap: 1 }}>
                    <Text style={type.body} numberOfLines={1}>
                      {entry.label}
                    </Text>
                    {entry.summary ? (
                      <Text style={[type.caption, { color: colors.onSurfaceMuted }]} numberOfLines={1}>
                        {entry.summary}
                      </Text>
                    ) : null}
                  </View>
                  {entry.value ? (
                    <Text style={[type.captionStrong, { fontVariant: ["tabular-nums"] }]} numberOfLines={1}>
                      {fmtMoneyCompact(entry.value)}
                    </Text>
                  ) : null}
                </Pressable>
              ))}
            </View>
          ))
        )}
      </View>
    </Card>
  );
}
