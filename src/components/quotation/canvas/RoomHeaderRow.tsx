// Active room heading with room totals and actions.
import { useState } from "react";
import Feather from "@expo/vector-icons/Feather";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { colors, font, money, radius, type } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { useBuilder } from "../context/BuilderContext";
import { RoomProductsSheet } from "../sheets/RoomProductsSheet";

export function RoomHeaderRow({
  roomName, itemCount, subtotal, roomDiscount,
}: {
  roomName: string;
  itemCount: number;
  subtotal: number;
  roomDiscount?: { type: "percent" | "amount"; value: number } | null;
}) {
  const b = useBuilder();
  const [actionsOpen, setActionsOpen] = useState(false);
  const [productsAction, setProductsAction] = useState<"increase" | "copy" | null>(null);
  const isRenaming = b.inlineRenameRoom === roomName;
  const roomIndex = b.s.rooms.indexOf(roomName);
  const first = roomIndex <= 0;
  const last = roomIndex === b.s.rooms.length - 1;

  const moveToTop = () => {
    if (first) return;
    b.onRoomDragEnd({ data: [roomName, ...b.s.rooms.filter((room) => room !== roomName)] });
  };

  const commit = () => {
    if (b.inlineRenameRoom) b.renameRoom(b.inlineRenameRoom, b.inlineRenameValue);
    b.setInlineRenameRoom(null);
  };

  const actions = (
    <>
      {b.s.rooms.length > 1 ? <View style={styles.orderActions}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Move ${roomName} to top`} accessibilityState={{ disabled: first }} disabled={first} testID={`room-top-${roomName}`} onPress={moveToTop} style={[styles.orderButton, first && styles.orderButtonDisabled]}>
          <Feather name="chevrons-up" size={14} color={colors.onSurfaceMuted} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Move ${roomName} up`} accessibilityState={{ disabled: first }} disabled={first} testID={`room-up-${roomName}`} onPress={() => b.moveRoom(roomName, -1)} style={[styles.orderButton, first && styles.orderButtonDisabled]}>
          <Feather name="arrow-up" size={14} color={colors.onSurfaceMuted} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Move ${roomName} down`} accessibilityState={{ disabled: last }} disabled={last} testID={`room-down-${roomName}`} onPress={() => b.moveRoom(roomName, 1)} style={[styles.orderButton, last && styles.orderButtonDisabled]}>
          <Feather name="arrow-down" size={14} color={colors.onSurfaceMuted} />
        </Pressable>
      </View> : null}
      <Pressable
        testID={`room-rename-${roomName}`}
        accessibilityRole="button"
        accessibilityLabel={`${isRenaming ? "Finish renaming" : "Rename"} ${roomName}`}
        hitSlop={8}
        onPress={() => {
          if (isRenaming) commit();
          else { b.setInlineRenameRoom(roomName); b.setInlineRenameValue(roomName); }
        }}
        style={styles.iconAction}
      >
        <Feather name={isRenaming ? "check" : "edit-2"} size={14} color={isRenaming ? ds.brass : colors.onSurfaceMuted} />
      </Pressable>
      <Pressable
        testID={`room-discount-${roomName}`}
        accessibilityRole="button"
        accessibilityLabel={`${roomDiscount ? "Edit" : "Add"} ${roomName} discount`}
        hitSlop={8}
        onPress={() => b.setDiscountSheet({ kind: "room", room: roomName })}
        style={[styles.discountChip, roomDiscount && styles.discountChipActive]}
      >
        <Feather name="percent" size={11} color={roomDiscount ? ds.brass : colors.onSurfaceMuted} />
        {roomDiscount ? (
          <Text style={styles.discountChipLabel}>
            {roomDiscount.type === "percent" ? `${roomDiscount.value}%` : `₹${roomDiscount.value.toLocaleString("en-IN")}`}
          </Text>
        ) : null}
      </Pressable>
      <Pressable testID={`room-dup-${roomName}`} accessibilityRole="button" accessibilityLabel={`Duplicate ${roomName}`} hitSlop={8} onPress={() => b.duplicateRoom(roomName)} style={styles.iconAction}>
        <Feather name="copy" size={14} color={colors.onSurfaceMuted} />
      </Pressable>
      <Pressable testID={`room-delete-${roomName}`} accessibilityRole="button" accessibilityLabel={`Delete ${roomName}`} hitSlop={8} onPress={() => b.deleteRoom(roomName)} style={styles.iconAction}>
        <Feather name="trash-2" size={14} color={colors.error} />
      </Pressable>
    </>
  );

  return (
    <View style={styles.wrap} testID={`room-header-${roomName}`}>
      <View style={styles.mainRow}>
        {isRenaming ? (
          <TextInput
            testID={`room-inline-input-${roomName}`}
            value={b.inlineRenameValue}
            onChangeText={b.setInlineRenameValue}
            autoFocus
            onBlur={commit}
            onSubmitEditing={commit}
            onKeyPress={(e) => { if ((e.nativeEvent as any).key === "Escape") b.setInlineRenameRoom(null); }}
            returnKeyType="done"
            style={styles.inlineInput}
            selectTextOnFocus
          />
        ) : (
          <View testID={`room-name-${roomName}`} style={styles.roomLabel}>
            <Text accessibilityRole="header" style={styles.roomName}>{roomName}</Text>
            <Text style={type.caption}>{itemCount} {itemCount === 1 ? "product" : "products"} · {money(subtotal)}</Text>
          </View>
        )}
        <Pressable accessibilityRole="button" accessibilityLabel={`Room actions for ${roomName}`}
          accessibilityState={{ expanded: actionsOpen }} onPress={() => setActionsOpen(open => !open)}
          testID={`room-actions-${roomName}`} style={[styles.iconAction, actionsOpen && styles.productActionPressed]}>
          <Feather name={actionsOpen ? "chevron-up" : "more-horizontal"} size={18} color={colors.onSurfaceSecondary} />
        </Pressable>
      </View>
      {actionsOpen ? <View style={styles.additionalActions}>{actions}</View> : null}
      {itemCount ? <View style={styles.productActions}>
        <Pressable accessibilityRole="button" onPress={() => setProductsAction("increase")} testID="bulk-room-quantity"
          style={({ pressed }) => [styles.productAction, pressed && styles.productActionPressed]}>
          <Feather name="plus" size={15} color={colors.onSurfaceSecondary} />
          <Text style={styles.productActionLabel}>Increase quantities</Text>
        </Pressable>
        {b.s.rooms.length > 1 ? <Pressable accessibilityRole="button" onPress={() => setProductsAction("copy")} testID="copy-room-products"
          style={({ pressed }) => [styles.productAction, pressed && styles.productActionPressed]}>
          <Feather name="copy" size={15} color={colors.onSurfaceSecondary} />
          <Text style={styles.productActionLabel}>Copy products</Text>
        </Pressable> : null}
      </View> : null}
      {productsAction ? <RoomProductsSheet room={roomName} mode={productsAction} onClose={() => setProductsAction(null)} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    gap: 8, paddingVertical: 10, paddingHorizontal: 10,
    borderRadius: radius.sm, backgroundColor: colors.surfaceSubtle, marginTop: 6,
  },
  mainRow: { flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 },
  additionalActions: { flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: 6, paddingTop: 6, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border },
  productActions: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  productAction: { minHeight: 44, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 8, borderRadius: radius.sm },
  productActionPressed: { backgroundColor: colors.surfaceTertiary },
  productActionLabel: { fontSize: 13, fontWeight: "600", color: colors.onSurface },
  orderActions: { flexDirection: "row", alignItems: "center", gap: 2 },
  orderButton: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  orderButtonDisabled: { opacity: 0.35 },
  iconAction: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  roomLabel: { flex: 1, minWidth: 0, minHeight: 44, justifyContent: "center" },
  roomName: { fontSize: 15, fontFamily: font.semibold, fontWeight: "600", color: colors.onSurface, letterSpacing: -0.1 },
  inlineInput: {
    flex: 1, fontSize: 14, fontFamily: font.semibold, fontWeight: "600", color: colors.onSurface,
    paddingVertical: 4, paddingHorizontal: 6, borderRadius: 6,
    backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: ds.brassLine,
  },
  discountChip: {
    minWidth: 44, minHeight: 44, justifyContent: "center", flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 4,
    borderRadius: 6, backgroundColor: colors.surfaceSecondary,
  },
  discountChipActive: { backgroundColor: ds.brassTint },
  discountChipLabel: { fontSize: 10.5, fontFamily: font.semibold, fontWeight: "600", color: ds.brass },
});
