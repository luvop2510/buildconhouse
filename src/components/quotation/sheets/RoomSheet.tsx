// Room add/rename bottom sheet.
import { Pressable, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { BottomSheet } from "@/src/components/BottomSheet";
import { Button } from "@/src/components/ui";
import { colors, radius, spacing } from "@/src/theme/tokens";

import { useBuilder } from "../context/BuilderContext";
import { DEFAULT_ROOMS } from "../helpers/types";

export function RoomSheet() {
  const b = useBuilder();
  const cur = b.roomSheet;
  const close = () => b.setRoomSheet(null);

  const submit = () => {
    if (cur?.kind === "add") b.addRoom(b.roomInput);
    else if (cur?.kind === "rename") b.renameRoom(cur.name, b.roomInput);
    close();
  };

  return (
    <BottomSheet
      visible={!!cur}
      onClose={close}
      title={cur?.kind === "add" ? "Add room" : "Rename room"}
      testID="room-sheet"
      footer={
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button label="Cancel" variant="secondary" onPress={close} />
          <Button label={cur?.kind === "add" ? "Add" : "Done"} testID="submit-room" onPress={submit} />
        </View>
      }
    >
      <View style={{ gap: spacing.md }}>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {DEFAULT_ROOMS.filter((r) => !b.s.rooms.includes(r)).map((r) => (
            <Pressable
              key={r}
              testID={`suggest-${r}`}
              onPress={() => b.setRoomInput(r)}
              style={styles.suggestion}
            >
              <Text style={{ fontSize: 12, fontWeight: "600", color: colors.onSurfaceSecondary }}>{r}</Text>
            </Pressable>
          ))}
        </View>
        <TextInput
          testID="room-input"
          value={b.roomInput}
          onChangeText={b.setRoomInput}
          placeholder="e.g. Master Bath"
          style={styles.bigInput}
          autoFocus
        />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  bigInput: {
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.onSurface,
  },
  suggestion: {
    paddingHorizontal: 10, paddingVertical: 6, borderRadius: 999,
    backgroundColor: colors.surfaceTertiary, borderWidth: 1, borderColor: colors.border,
  },
});
