// Room chip row — horizontal DnD reorder + add-room button.
import { Feather } from "@expo/vector-icons";
import { Pressable, StyleSheet, Text, View } from "react-native";
import DraggableFlatList, { RenderItemParams, ScaleDecorator } from "react-native-draggable-flatlist";

import { colors } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { useBuilder } from "../context/BuilderContext";
import { grabCursor } from "../shared/grabCursor";

export function RoomChipRow() {
  const b = useBuilder();
  const knownRooms = new Set(b.s.rooms);
  const fallbackRoom = b.s.rooms[0];
  const itemCountByRoom = b.s.lines.reduce<Record<string, number>>((counts, line) => {
    const room = line.room && knownRooms.has(line.room) ? line.room : fallbackRoom;
    if (room) counts[room] = (counts[room] || 0) + 1;
    return counts;
  }, {});

  const renderChip = ({ item, drag, isActive }: RenderItemParams<string>) => {
    const active = b.s.activeRoom === item;
    const count = itemCountByRoom[item] || 0;
    return (
      <ScaleDecorator>
        <Pressable
          onLongPress={drag}
          delayLongPress={160}
          accessibilityRole="button" accessibilityState={{ selected: active }}
          onPress={() => b.setActiveRoom(item)}
          testID={`room-${item}`}
          style={[styles.tab, active && styles.tabActive, isActive && { opacity: 0.7 }, grabCursor]}
        >
          <Feather name="menu" size={11} color={active ? ds.brassDeep : colors.onSurfaceMuted} style={{ opacity: 0.7, marginRight: 4 }} />
          <Text numberOfLines={1} style={[styles.roomName, active && styles.roomNameActive]}>{item}</Text>
          <View style={[styles.count, active && styles.countActive]}><Text style={[styles.countLabel, active && styles.countLabelActive]}>{count}</Text></View>
        </Pressable>
      </ScaleDecorator>
    );
  };

  return (
    <View style={styles.wrap}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <DraggableFlatList
          data={b.s.rooms}
          horizontal
          keyExtractor={(r) => r}
          onDragEnd={b.onRoomDragEnd}
          renderItem={renderChip}
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6, paddingVertical: 2 }}
          activationDistance={8}
        />
      </View>
      <Pressable
        onPress={() => { b.setRoomInput(""); b.setRoomSheet({ kind: "add" }); }}
        testID="add-room-btn" accessibilityRole="button" accessibilityLabel="Add room"
        style={[styles.tab, styles.addRoom]}
      >
        <Feather name="plus" size={13} color={colors.onSurfaceMuted} />
        <Text style={styles.addRoomLabel}>Add room</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  tab: {
    minHeight: 44, minWidth: 44, justifyContent: "center", flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
  },
  tabActive: { backgroundColor: ds.brassTint, borderColor: ds.brassLine },
  roomName: { maxWidth: 116, fontSize: 12, fontWeight: "600", color: colors.onSurfaceSecondary },
  roomNameActive: { color: ds.brassDeep },
  count: { minWidth: 19, height: 19, paddingHorizontal: 5, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary },
  countActive: { backgroundColor: colors.surface },
  countLabel: { fontSize: 10, fontWeight: "700", color: colors.onSurfaceMuted, fontVariant: ["tabular-nums"] },
  countLabelActive: { color: ds.brassDeep },
  addRoom: { borderStyle: "dashed", paddingHorizontal: 10, gap: 5 },
  addRoomLabel: { fontSize: 11, fontWeight: "700", color: colors.onSurfaceSecondary },
});
