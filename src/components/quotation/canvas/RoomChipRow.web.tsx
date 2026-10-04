// Browser variant: use HTML drag events for quotation section ordering.
import Feather from "@expo/vector-icons/Feather";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";

import { colors } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";

import { useBuilder } from "../context/BuilderContext";

export function RoomChipRow() {
  const b = useBuilder();
  const [draggingRoom, setDraggingRoom] = useState<string | null>(null);
  const [dropRoom, setDropRoom] = useState<string | null>(null);
  const knownRooms = new Set(b.s.rooms);
  const fallbackRoom = b.s.rooms[0];
  const itemCountByRoom = b.s.lines.reduce<Record<string, number>>((counts, line) => {
    const room = line.room && knownRooms.has(line.room) ? line.room : fallbackRoom;
    if (room) counts[room] = (counts[room] || 0) + 1;
    return counts;
  }, {});
  const dropOnRoom = (target: string, source: string) => {
    if (b.s.rooms.includes(source) && source !== target) {
      const rooms = b.s.rooms.filter((room) => room !== source);
      rooms.splice(rooms.indexOf(target), 0, source);
      b.onRoomDragEnd({ data: rooms });
    }
    setDraggingRoom(null);
    setDropRoom(null);
  };
  return (
    <View style={styles.wrap}>
      <ScrollView horizontal style={{ flex: 1, minWidth: 0 }} contentContainerStyle={{ gap: 6, paddingVertical: 2 }} showsHorizontalScrollIndicator={false}>
        {b.s.rooms.map((room) => {
          const active = b.s.activeRoom === room;
          const count = itemCountByRoom[room] || 0;
          return <Pressable
            key={room}
            accessibilityRole="button" accessibilityState={{ selected: active }}
            accessibilityLabel={`${room}, ${count} products. Drag to reorder quotation sections.`}
            onPress={() => b.setActiveRoom(room)} testID={`room-${room}`}
            style={({ pressed }) => [styles.tab, active && styles.tabActive, dropRoom === room && styles.tabDrop, pressed && styles.tabPressed]}
            {...({
              draggable: true,
              onDragStart: (event: any) => {
                event.dataTransfer?.setData("text/plain", room);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                setDraggingRoom(room);
              },
              onDragOver: (event: any) => { event.preventDefault(); setDropRoom(room); },
              onDrop: (event: any) => { event.preventDefault(); dropOnRoom(room, event.dataTransfer?.getData("text/plain") || draggingRoom || ""); },
              onDragEnd: () => { setDraggingRoom(null); setDropRoom(null); },
            } as any)}
          ><Feather name="menu" size={11} color={active ? ds.brassDeep : colors.onSurfaceMuted} style={{ marginRight: 4 }} /><Text numberOfLines={1} style={[styles.roomName, active && styles.roomNameActive]}>{room}</Text><View style={[styles.count, active && styles.countActive]}><Text style={[styles.countLabel, active && styles.countLabelActive]}>{count}</Text></View></Pressable>;
        })}
      </ScrollView>
      <Pressable accessibilityRole="button" accessibilityLabel="Add room" onPress={() => { b.setRoomInput(""); b.setRoomSheet({ kind: "add" }); }} testID="add-room-btn" style={({ pressed }) => [styles.tab, styles.addRoom, pressed && styles.tabPressed]}><Feather name="plus" size={13} color={colors.onSurfaceMuted} /><Text style={styles.addRoomLabel}>Add room</Text></Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "center", gap: 6 },
  tab: { flexDirection: "row", alignItems: "center", paddingHorizontal: 12, paddingVertical: 6, borderRadius: 999, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary },
  tabActive: { backgroundColor: ds.brassTint, borderColor: ds.brassLine },
  tabDrop: { borderColor: ds.brassDeep, borderWidth: 2 },
  tabPressed: { opacity: 0.76, transform: [{ scale: 0.98 }] },
  roomName: { maxWidth: 116, fontSize: 12, fontWeight: "600", color: colors.onSurfaceSecondary },
  roomNameActive: { color: ds.brassDeep },
  count: { minWidth: 19, height: 19, marginLeft: 5, paddingHorizontal: 5, borderRadius: 10, alignItems: "center", justifyContent: "center", backgroundColor: colors.surfaceTertiary },
  countActive: { backgroundColor: colors.surface },
  countLabel: { fontSize: 10, fontWeight: "700", color: colors.onSurfaceMuted, fontVariant: ["tabular-nums"] },
  countLabelActive: { color: ds.brassDeep },
  addRoom: { borderStyle: "dashed", paddingHorizontal: 10, gap: 5 },
  addRoomLabel: { fontSize: 11, fontWeight: "700", color: colors.onSurfaceSecondary },
});
