import Feather from "@expo/vector-icons/Feather";
import { Pressable, StyleSheet, View } from "react-native";

import { Text } from "@/src/components/AppText";
import { EmptyState } from "@/src/components/ui";
import { color as ds } from "@/src/design/tokens";
import { font, radius, spacing } from "@/src/theme/tokens";
import { useBuilder } from "../context/BuilderContext";

export function EmptyRoom({ compact }: { compact: boolean }) {
  const b = useBuilder();
  return (
    <View style={styles.wrap}>
      <EmptyState icon="file-plus" title={b.s.lines.length ? "No products in this room" : "Add your first product"}
        subtitle={compact ? "Browse the catalogue to add products to this room." : "Choose a catalogue product to add it to this room."} />
      {compact ? <Pressable accessibilityRole="button" testID="empty-browse-catalog" onPress={() => b.setPickerSheetOpen(true)} style={styles.browseBtn}>
        <Feather name="search" size={15} color={ds.canvas} />
        <Text style={styles.browseBtnText}>Browse catalog</Text>
      </Pressable> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { justifyContent: "center", paddingVertical: spacing.lg },
  browseBtn: {
    minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    marginTop: spacing.lg, marginHorizontal: spacing.xl, backgroundColor: ds.brass, borderRadius: radius.md,
  },
  browseBtnText: { color: ds.canvas, fontSize: 14, fontFamily: font.semibold, fontWeight: "600" },
});
