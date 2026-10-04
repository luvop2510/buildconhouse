// Room header row — draggable, inline-renameable, with room actions.
import Feather from "@expo/vector-icons/Feather";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import { colors, font, money, radius, type } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { useBuilder } from "../context/BuilderContext";
import { grabCursor } from "../shared/grabCursor";

export function RoomHeaderRow({
  roomName, itemCount, subtotal, collapsed, drag, isActive, roomDiscount,
}: {
  roomName: string;
  itemCount: number;
  subtotal: number;
  collapsed: boolean;
  drag: () => void;
  isActive: boolean;
  roomDiscount?: { type: "percent" | "amount"; value: number } | null;
}) {
  const b = useBuilder();
  const isActiveRoom = b.s.activeRoom === roomName;
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

  return (
    <View style={[styles.wrap, isActiveRoom && styles.wrapActive, isActive && { opacity: 0.7 }]}>
      <Pressable
        onLongPress={drag}
        delayLongPress={160}
        hitSlop={6}
        accessibilityRole="button"
        accessibilityLabel={`Drag ${roomName} to reorder quotation sections`}
        style={[styles.dragHandle, grabCursor]}
        testID={`room-drag-${roomName}`}
      >
        <Feather name="menu" size={13} color={colors.onSurfaceMuted} />
      </Pressable>
      <Pressable onPress={() => b.toggleCollapse(roomName)} testID={`room-toggle-${roomName}`} hitSlop={6}>
        <Feather name={collapsed ? "chevron-right" : "chevron-down"} size={16} color={colors.onSurface} />
      </Pressable>
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
        <Pressable onPress={() => b.setActiveRoom(roomName)} style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.roomName} numberOfLines={1}>{roomName}</Text>
          <Text style={type.caption} numberOfLines={1}>{itemCount} items · {money(subtotal)}</Text>
        </Pressable>
      )}
      <View style={styles.orderActions}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Move ${roomName} to top`} accessibilityState={{ disabled: first }} disabled={first} testID={`room-top-${roomName}`} onPress={moveToTop} style={[styles.orderButton, first && styles.orderButtonDisabled]}>
          <Feather name="chevrons-up" size={14} color={colors.onSurfaceMuted} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Move ${roomName} up`} accessibilityState={{ disabled: first }} disabled={first} testID={`room-up-${roomName}`} onPress={() => b.moveRoom(roomName, -1)} style={[styles.orderButton, first && styles.orderButtonDisabled]}>
          <Feather name="arrow-up" size={14} color={colors.onSurfaceMuted} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={`Move ${roomName} down`} accessibilityState={{ disabled: last }} disabled={last} testID={`room-down-${roomName}`} onPress={() => b.moveRoom(roomName, 1)} style={[styles.orderButton, last && styles.orderButtonDisabled]}>
          <Feather name="arrow-down" size={14} color={colors.onSurfaceMuted} />
        </Pressable>
      </View>
      <Pressable
        testID={`room-rename-${roomName}`}
        hitSlop={8}
        onPress={() => {
          if (isRenaming) commit();
          else { b.setInlineRenameRoom(roomName); b.setInlineRenameValue(roomName); }
        }}
      >
        <Feather name={isRenaming ? "check" : "edit-2"} size={14} color={isRenaming ? ds.brass : colors.onSurfaceMuted} />
      </Pressable>
      <Pressable
        testID={`room-discount-${roomName}`}
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
      <Pressable testID={`room-dup-${roomName}`} hitSlop={8} onPress={() => b.duplicateRoom(roomName)}>
        <Feather name="copy" size={14} color={colors.onSurfaceMuted} />
      </Pressable>
      <Pressable testID={`room-delete-${roomName}`} hitSlop={8} onPress={() => b.deleteRoom(roomName)}>
        <Feather name="trash-2" size={14} color={colors.error} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 10, paddingHorizontal: 10,
    borderRadius: radius.sm, backgroundColor: colors.surfaceSubtle,
    borderLeftWidth: 3, borderLeftColor: "transparent", marginTop: 6,
  },
  wrapActive: { borderLeftColor: ds.brass, backgroundColor: ds.brassTint },
  dragHandle: {
    width: 20, alignItems: "center", justifyContent: "center", alignSelf: "stretch",
    marginRight: -2, marginLeft: -4,
  },
  orderActions: { flexDirection: "row", alignItems: "center", gap: 2 },
  orderButton: { width: 26, height: 30, alignItems: "center", justifyContent: "center" },
  orderButtonDisabled: { opacity: 0.35 },
  roomName: { fontSize: 13, fontFamily: font.semibold, fontWeight: "600", color: colors.onSurface, letterSpacing: -0.1 },
  inlineInput: {
    flex: 1, fontSize: 14, fontFamily: font.semibold, fontWeight: "600", color: colors.onSurface,
    paddingVertical: 4, paddingHorizontal: 6, borderRadius: 6,
    backgroundColor: colors.surfaceSecondary, borderWidth: 1, borderColor: ds.brassLine,
  },
  discountChip: {
    flexDirection: "row", alignItems: "center", gap: 3, paddingHorizontal: 6, paddingVertical: 4,
    borderRadius: 6, backgroundColor: colors.surfaceSecondary,
  },
  discountChipActive: { backgroundColor: ds.brassTint },
  discountChipLabel: { fontSize: 10.5, fontFamily: font.semibold, fontWeight: "600", color: ds.brass },
});
