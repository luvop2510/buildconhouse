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

  const renderChip = ({ item, drag, isActive }: RenderItemParams<string>) => {
    const active = b.s.activeRoom === item;
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
          <Text style={{ fontSize: 12, fontWeight: "600", color: active ? ds.brassDeep : colors.onSurfaceSecondary }}>{item}</Text>
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
        style={[styles.tab, { borderStyle: "dashed", paddingHorizontal: 10 }]}
      >
        <Feather name="plus" size={13} color={colors.onSurfaceMuted} />
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
});
