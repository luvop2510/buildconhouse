// ProductPickerSheet — full-screen mobile picker.
// Wraps the shared ProductExplorer grid, presented as a modal for one-handed
// mobile use. Keeping this route on ProductExplorer is what gives Sanitary
// Bathroom Add Products the same shop-style filters and responsive browsing
// experience as the inline quotation catalog.
import { useState } from "react";
import { Overlay } from "@/src/design/Overlay";
import Feather from "@expo/vector-icons/Feather";
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { colors, money, spacing, type } from "@/src/theme/tokens";

import { ProductExplorer } from "../catalog/ProductExplorer";
import { RoomChipRow } from "../canvas/RoomChipRow";
import { useBuilder } from "../context/BuilderContext";

export function ProductPickerSheet() {
  const b = useBuilder();
  const [roomsOpen, setRoomsOpen] = useState(false);

  return (
    <Overlay open={b.pickerSheetOpen} onClose={() => b.setPickerSheetOpen(false)} title="Add products" presentation="fullscreen" scroll={false} header={false}>
      <SafeAreaView edges={[]} style={{ flex: 1, backgroundColor: colors.surface }}>
        <View style={{ flex: 1, minHeight: 0 }}>
          <ProductExplorer showCompactFilters scrollHeader={<>
        <View style={styles.head}>
          <Pressable onPress={() => b.setPickerSheetOpen(false)} style={styles.close} testID="picker-sheet-close" accessibilityRole="button" accessibilityLabel="Close product picker">
            <Feather name="x" size={22} color={colors.onSurface} />
          </Pressable>
          <Text accessibilityRole="header" style={type.titleMd}>Add products</Text>
          <View style={{ width: 22 }} />
        </View>
        <View style={{ paddingHorizontal: 12 }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Choose room for added products" accessibilityState={{ expanded: roomsOpen }}
            testID="picker-room-toggle" onPress={() => setRoomsOpen(value => !value)} style={styles.roomToggle}>
            <Text style={[styles.destination, { flex: 1, marginBottom: 0 }]} numberOfLines={1}>Adding to {b.s.activeRoom}</Text>
            <Text style={styles.changeRoom}>Change room</Text><Feather name={roomsOpen ? "chevron-up" : "chevron-down"} size={14} color={colors.onSurfaceSecondary} />
          </Pressable>
          {roomsOpen ? <View style={{ paddingBottom: 8 }}><RoomChipRow /></View> : null}
        </View>
          </>} />
        </View>
        <View style={styles.summary}>
          <View style={{ flex: 1, minWidth: 0 }} accessibilityLiveRegion="polite">
            <Text style={styles.destination}>{b.s.lines.length} items in quotation</Text>
            <Text style={styles.total} numberOfLines={1}>{money(b.totals.grand)}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Back to quotation" testID="picker-view-quotation" onPress={() => b.setPickerSheetOpen(false)} style={styles.review}>
            <Text style={styles.reviewLabel}>Done adding</Text><Feather name="check" size={16} color={colors.onBrand} />
          </Pressable>
        </View>
      </SafeAreaView>
    </Overlay>
  );
}

const styles = StyleSheet.create({
  roomToggle: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6 },
  changeRoom: { fontSize: 12, fontWeight: "600", color: colors.onSurfaceSecondary },
  summary: { flexDirection: "row", alignItems: "center", padding: 12, gap: 12, borderTopWidth: 1, borderColor: colors.border },
  destination: { fontSize: 12, color: colors.onSurfaceSecondary, marginBottom: 4 },
  total: { fontSize: 20, fontWeight: "600", color: colors.onSurface },
  review: { minHeight: 44, paddingHorizontal: 16, borderRadius: 10, backgroundColor: colors.brand, flexDirection: "row", alignItems: "center", gap: 8 },
  reviewLabel: { fontSize: 13, fontWeight: "700", color: colors.onBrand },
  head: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "center",
    paddingHorizontal: spacing.md, paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  close: { width: 44, height: 44, alignItems: "center", justifyContent: "center", marginLeft: -11 },
});
