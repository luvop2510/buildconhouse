// Browser variant: use FlatList rather than the native draggable list, which
// depends on a Reanimated gesture runtime unavailable in the web shell.
import { FlatList, Pressable, StyleSheet, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";

import { EmptyState } from "@/src/components/ui";
import { font, radius, spacing } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { useBuilder } from "../context/BuilderContext";
import { LineRow } from "./LineRow";
import { RoomHeaderRow } from "./RoomHeaderRow";

export function QuotationCanvas({ compact = false }: { compact?: boolean }) {
  const b = useBuilder();
  if (b.flatRows.length === 0 || (b.flatRows.length <= b.s.rooms.length && b.s.lines.length === 0)) {
    return <View style={{ flex: 1, justifyContent: "center" }}><EmptyState icon="file-plus" title="Add your first product" subtitle={compact ? "Tap Browse catalog to search and add products. Everything totals live." : "Search on the left and tap to add. Everything totals live."} />{compact ? <Pressable testID="empty-browse-catalog" onPress={() => b.setPickerSheetOpen(true)} style={styles.browseBtn}><Feather name="search" size={15} color={ds.canvas} /><Text style={styles.browseBtnText}>Browse catalog</Text></Pressable> : null}</View>;
  }
  return <FlatList data={b.flatRows} keyExtractor={(row) => row.id} style={{ flex: 1, minHeight: 0 }} contentContainerStyle={{ padding: spacing.md, gap: 6, paddingBottom: 32 }} keyboardShouldPersistTaps="handled" testID="receipt-list" renderItem={({ item }) => item.kind === "room-header" ? <RoomHeaderRow roomName={item.roomName} itemCount={item.itemCount} subtotal={item.subtotal} collapsed={item.collapsed} drag={() => {}} isActive={false} roomDiscount={item.roomDiscount} /> : <LineRow line={item.line} drag={() => {}} isActive={false} catDiscs={b.s.categoryDiscounts} projDisc={b.s.projectDiscount} roomDiscs={b.s.roomDiscounts} compact={compact} />} />;
}

const styles = StyleSheet.create({
  browseBtn: { flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, marginTop: spacing.lg, marginHorizontal: spacing.xl, backgroundColor: ds.brass, paddingVertical: 12, borderRadius: radius.md },
  browseBtnText: { color: ds.canvas, fontSize: 14, fontFamily: font.semibold, fontWeight: "600" },
});
