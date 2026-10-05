import { ReactNode, useState } from "react";
import { LayoutChangeEvent, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { colors, spacing, type } from "@/src/theme/tokens";

/** Why a chart is not showing data. Mirrors the backend's history_state so
 *  the UI never has to invent a reason — or a number. */
export type ChartState = "ready" | "loading" | "empty" | "no_prior_period" | "insufficient_history";

const STATE_COPY: Record<Exclude<ChartState, "ready">, string> = {
  loading: "Loading…",
  empty: "No data in this period",
  no_prior_period: "No previous period available.",
  insufficient_history: "Historical comparison available after more business history is collected.",
};

type Props = {
  height: number;
  state?: ChartState;
  stateLabel?: string;
  testID?: string;
  children: (width: number) => ReactNode;
};

/**
 * The one frame every BuildCon chart renders inside.
 *
 * Owns responsive width measurement and every non-data state, so an
 * individual chart only ever draws marks. Adding a new chart type must not
 * require changing this file.
 *
 * Width comes from onLayout rather than useWindowDimensions because charts
 * sit inside cards and grids whose width is not the window's.
 */
export function ChartFrame({ height, state = "ready", stateLabel, testID, children }: Props) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) => setWidth(e.nativeEvent.layout.width);

  return (
    <View testID={testID} onLayout={onLayout} style={{ height, justifyContent: "center" }}>
      {state !== "ready" ? (
        <View style={{ alignItems: "center", justifyContent: "center", paddingHorizontal: spacing.md }}>
          <Text style={[type.caption, { color: colors.onSurfaceMuted, textAlign: "center" }]}>
            {stateLabel || STATE_COPY[state]}
          </Text>
        </View>
      ) : width > 0 ? (
        children(width)
      ) : null}
    </View>
  );
}
