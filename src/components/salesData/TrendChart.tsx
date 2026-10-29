import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { fmtMoney, fmtMoneyCompact } from "@/src/design/tokens";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

export function TrendChart({ points }: { points: { bucket: string; revenue: number }[] }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [availableWidth, setAvailableWidth] = useState(280);
  if (points.length === 0) {
    return <Text style={[type.bodyMuted, { padding: spacing.lg, textAlign: "center" }]}>No data in this range</Text>;
  }
  const max = Math.max(...points.map((p) => p.revenue), 1);
  // A daily range can have 31 buckets. Let the chart own that horizontal
  // overflow rather than shrinking each bar and label into illegibility (or
  // making the entire AdminPage scroll sideways).
  const chartWidth = Math.max(availableWidth - spacing.xs * 2, points.length * 68);
  return (
    <View style={{ gap: spacing.sm }} onLayout={event => setAvailableWidth(event.nativeEvent.layout.width)}>
    <Text accessibilityLiveRegion="polite" style={type.caption}>{selected && points.find(p => p.bucket === selected) ? `${selected}: ₹${fmtMoney(points.find(p => p.bucket === selected)!.revenue)}` : "Select a bar for its exact value. Scroll to see the full period."}</Text>
    <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ paddingHorizontal: spacing.xs }} accessibilityLabel="Revenue trend chart">
      <View style={{ width: chartWidth, flexDirection: "row", alignItems: "flex-end", gap: 6, height: 140, paddingHorizontal: spacing.md }}>
      {points.map((p) => (
        <Pressable key={p.bucket} onPress={() => setSelected(p.bucket)} accessibilityRole="button" accessibilityLabel={`${p.bucket}: ₹${fmtMoney(p.revenue)}`} accessibilityState={{ selected: selected === p.bucket }} style={{ flex: 1, minWidth: 48, alignItems: "center", gap: 4 }}>
          <Text style={{ fontSize: 11, color: colors.onSurfaceMuted }} numberOfLines={1}>
            {fmtMoneyCompact(p.revenue)}
          </Text>
          <View
            style={{
              width: "100%",
              height: Math.max(0, (p.revenue / max) * 90),
              backgroundColor: selected === p.bucket ? colors.brandHover : colors.brand,
              borderRadius: radius.sm,
            }}
          />
          <Text style={{ fontSize: 11, color: colors.onSurfaceMuted }} numberOfLines={1}>{p.bucket}</Text>
        </Pressable>
      ))}
      </View>
    </ScrollView>
    </View>
  );
}
