// QuotationCanvas — the DnD flat list that mixes room headers + lines.
import { Pressable, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import Feather from "@expo/vector-icons/Feather";
import DraggableFlatList, { RenderItemParams } from "react-native-draggable-flatlist";

import { EmptyState } from "@/src/components/ui";
import { font, radius, spacing } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { useBuilder } from "../context/BuilderContext";
import type { BuilderRow } from "../helpers/types";
import { LineRow } from "./LineRow";
import { RoomHeaderRow } from "./RoomHeaderRow";

export function QuotationCanvas({ compact = false }: { compact?: boolean }) {
  const b = useBuilder();

  const renderItem = ({ item, drag, isActive }: RenderItemParams<BuilderRow>) => {
    if (item.kind === "room-header") {
      return (
        <RoomHeaderRow
          roomName={item.roomName}
          itemCount={item.itemCount}
          subtotal={item.subtotal}
          collapsed={item.collapsed}
          drag={drag}
          isActive={isActive}
          roomDiscount={item.roomDiscount}
        />
      );
    }
    return (
      <LineRow
        line={item.line}
        drag={drag}
        isActive={isActive}
        catDiscs={b.s.categoryDiscounts}
        projDisc={b.s.projectDiscount}
        roomDiscs={b.s.roomDiscounts}
        compact={compact}
      />
    );
  };

  if (b.flatRows.length === 0 || (b.flatRows.length <= b.s.rooms.length && b.s.lines.length === 0)) {
    return (
      <View style={{ flex: 1, justifyContent: "center" }}>
        <EmptyState
          icon="file-plus"
          title="Add your first product"
          subtitle={compact ? "Tap Browse catalog to search and add products. Everything totals live." : "Search on the left and tap to add. Everything totals live."}
        />
        {compact ? (
          <Pressable
            testID="empty-browse-catalog"
            onPress={() => b.setPickerSheetOpen(true)}
            style={styles.browseBtn}
          >
            <Feather name="search" size={15} color={ds.canvas} />
            <Text style={styles.browseBtnText}>Browse catalog</Text>
          </Pressable>
        ) : null}
      </View>
    );
  }

  return (
    <DraggableFlatList
      data={b.flatRows}
      keyExtractor={(row) => row.id}
      onDragEnd={b.onLinesDragEnd}
      renderItem={renderItem}
      style={{ flex: 1, minHeight: 0 }}
      containerStyle={{ flex: 1, minHeight: 0, overflow: "hidden" }}
      contentContainerStyle={{ paddingHorizontal: compact ? spacing.xxl : spacing.md, paddingTop: spacing.md, gap: 6, paddingBottom: 32 }}
      activationDistance={10}
      keyboardShouldPersistTaps="handled"
      testID="receipt-list"
    />
  );
}

const styles = StyleSheet.create({
  browseBtn: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
    marginTop: spacing.lg, marginHorizontal: spacing.xl,
    backgroundColor: ds.brass, paddingVertical: 12, borderRadius: radius.md,
  },
  browseBtnText: { color: ds.canvas, fontSize: 14, fontFamily: font.semibold, fontWeight: "600" },
});
