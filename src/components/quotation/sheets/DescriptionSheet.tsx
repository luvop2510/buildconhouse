// Description sheet for a single line — free text printed on the PDF.
import { StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { BottomSheet } from "@/src/components/BottomSheet";
import { Button } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

import { useBuilder } from "../context/BuilderContext";

export function DescriptionSheet() {
  const b = useBuilder();
  const line = b.descSheet ? b.s.lines.find((x) => x.id === b.descSheet!.line_id) : null;
  const close = () => b.setDescSheet(null);

  return (
    <BottomSheet
      visible={!!b.descSheet}
      onClose={close}
      title="Item description"
      testID="desc-sheet"
      footer={
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button label="Done" onPress={close} testID="close-desc-sheet" />
        </View>
      }
    >
      {line ? (
        <View style={{ gap: spacing.md }}>
          <Text style={type.body}>{line.name}</Text>
          <TextInput
            testID="desc-input"
            value={line.description || ""}
            onChangeText={(v) => b.updateLine(line.id, { description: v }, "desc")}
            multiline
            placeholder="Add a note visible on the PDF (e.g. Installation excluded)"
            style={styles.bigInput}
          />
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  bigInput: {
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.onSurface,
    minHeight: 110, textAlignVertical: "top",
  },
});
