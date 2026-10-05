import { View } from "react-native";
import { Text } from "@/src/components/AppText";

import type { Comparison, HistoryState } from "@/src/api/executive";
import { colors, spacing, type } from "@/src/theme/tokens";

/**
 * The honest alternative to a delta.
 *
 * Deliberately NOT a second set of empty-state components: `EmptyState`,
 * `LoadingState` and `ErrorState` already exist in src/components/ui.tsx and
 * are used everywhere. This covers only the two states those cannot express —
 * "there is no previous period" and "there is not enough history yet" — which
 * come straight from the backend's `history_state` so the UI never has to
 * invent a reason, or a number.
 */
const COPY: Record<Exclude<HistoryState, "ok">, string> = {
  no_prior_period: "No previous period to compare",
  insufficient_history: "Comparison available once more history is collected",
};

export function HistoryNote({ state, testID }: { state: Exclude<HistoryState, "ok">; testID?: string }) {
  return (
    <Text testID={testID} style={[type.caption, { color: colors.onSurfaceMuted }]} numberOfLines={2}>
      {COPY[state]}
    </Text>
  );
}

const DIRECTION_COLOR = {
  up: colors.success,
  down: colors.error,
  flat: colors.onSurfaceMuted,
} as const;

/**
 * A comparison, or the reason there isn't one. Never +100%, never a bare 0%
 * standing in for "we don't know".
 */
export function ComparisonLine({
  comparison,
  previousLabel,
  testID,
}: {
  comparison: Comparison;
  previousLabel?: string | null;
  testID?: string;
}) {
  if (comparison.history_state !== "ok" || comparison.delta_pct === null) {
    return <HistoryNote state={comparison.history_state === "ok" ? "insufficient_history" : comparison.history_state} testID={testID} />;
  }
  const direction = comparison.direction ?? "flat";
  const arrow = direction === "up" ? "↑" : direction === "down" ? "↓" : "→";
  const sign = comparison.delta_pct > 0 ? "+" : "";
  return (
    <View testID={testID} style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: spacing.xs }}>
      <Text style={[type.captionStrong, { color: DIRECTION_COLOR[direction] }]}>
        {arrow} {sign}{comparison.delta_pct}%
      </Text>
      {previousLabel ? (
        <Text style={[type.caption, { color: colors.onSurfaceMuted }]} >
          vs {previousLabel.toLowerCase()}
        </Text>
      ) : null}
    </View>
  );
}
