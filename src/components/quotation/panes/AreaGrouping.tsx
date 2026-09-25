import { Feather } from "@expo/vector-icons";
import { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { colors, font, radius } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";
import { useBuilder } from "../context/BuilderContext";

const SUGGESTIONS = ["Basin Area", "WC Area", "Shower Area", "Other Area"];

/** Batch area assignment in the quotation pane, next to customer details. */
export function AreaGrouping() {
  const b = useBuilder();
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [area, setArea] = useState("");
  const room = b.s.activeRoom;
  const lines = b.s.lines.filter((line) => line.room === room && !line.included_for_line_id);
  const groups = new Set(lines.map((line) => line.area?.trim()).filter(Boolean)).size;
  useEffect(() => { setSelected([]); }, [room]);

  const apply = () => {
    if (!selected.length || !area.trim()) return;
    b.assignAreaToLines(selected, area);
    setSelected([]);
  };

  return (
    <View style={styles.wrap} testID="quotation-area-grouping">
      <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel="Group products by presentation area" onPress={() => setOpen((value) => !value)} style={styles.header}>
        <Feather name="layers" size={15} color={ds.brassDeep} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={styles.title}>Presentation areas</Text>
          <Text style={styles.meta} numberOfLines={1}>{room} · {groups} {groups === 1 ? "area" : "areas"}</Text>
        </View>
        <Feather name={open ? "chevron-up" : "chevron-down"} size={16} color={colors.onSurfaceMuted} />
      </Pressable>
      {open ? <View style={styles.editor}>
        <Text style={styles.hint}>Select products in this room, then give them one area name.</Text>
        <ScrollView style={{ maxHeight: 144 }} nestedScrollEnabled keyboardShouldPersistTaps="handled">
          {lines.map((line) => {
            const checked = selected.includes(line.id);
            return <Pressable key={line.id} accessibilityRole="checkbox" accessibilityState={{ checked }} accessibilityLabel={`${line.name}, ${line.area || "no area"}`} testID={`area-select-${line.id}`} onPress={() => setSelected((ids) => checked ? ids.filter((id) => id !== line.id) : [...ids, line.id])} style={styles.line}>
              <Feather name={checked ? "check-square" : "square"} size={18} color={checked ? ds.brassDeep : colors.onSurfaceMuted} />
              <Text style={styles.lineName} numberOfLines={1}>{line.name}</Text>
              {line.area ? <Text style={styles.lineArea} numberOfLines={1}>{line.area}</Text> : null}
            </Pressable>;
          })}
          {!lines.length ? <Text style={styles.hint}>Add products to this room first.</Text> : null}
        </ScrollView>
        <View style={styles.suggestions}>
          {SUGGESTIONS.map((name) => <Pressable key={name} accessibilityRole="button" onPress={() => setArea(name)} style={[styles.suggestion, area === name && styles.suggestionSelected]}>
            <Text style={styles.suggestionText}>{name}</Text>
          </Pressable>)}
        </View>
        <View style={styles.applyRow}>
          <TextInput testID="area-name-input" accessibilityLabel="Presentation area name" value={area} onChangeText={setArea} placeholder="Area name" placeholderTextColor={colors.onSurfaceMuted} style={styles.input} returnKeyType="done" onSubmitEditing={apply} />
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: !selected.length || !area.trim() }} testID="apply-area" disabled={!selected.length || !area.trim()} onPress={apply} style={[styles.apply, (!selected.length || !area.trim()) && { opacity: 0.45 }]}>
            <Text style={styles.applyText}>Apply · {selected.length}</Text>
          </Pressable>
        </View>
      </View> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border, backgroundColor: colors.surface },
  header: { flexDirection: "row", alignItems: "center", gap: 10, minHeight: 48, paddingHorizontal: 14, paddingVertical: 7 },
  title: { color: colors.onSurface, fontFamily: font.semibold, fontWeight: "600", fontSize: 12 },
  meta: { color: colors.onSurfaceMuted, fontSize: 11 },
  editor: { paddingHorizontal: 14, paddingBottom: 12, gap: 8 },
  hint: { color: colors.onSurfaceMuted, fontSize: 11 },
  line: { minHeight: 40, flexDirection: "row", alignItems: "center", gap: 8 },
  lineName: { flex: 1, minWidth: 0, color: colors.onSurface, fontSize: 12 },
  lineArea: { maxWidth: "36%", color: ds.brassDeep, fontSize: 11 },
  suggestions: { flexDirection: "row", flexWrap: "wrap", gap: 6 },
  suggestion: { borderRadius: 999, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 9, paddingVertical: 6 },
  suggestionSelected: { borderColor: ds.brassDeep, backgroundColor: ds.brassTint },
  suggestionText: { color: colors.onSurfaceSecondary, fontSize: 11 },
  applyRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  input: { flex: 1, minWidth: 0, minHeight: 42, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.border, paddingHorizontal: 10, color: colors.onSurface, fontSize: 13 },
  apply: { minHeight: 42, borderRadius: radius.sm, paddingHorizontal: 12, alignItems: "center", justifyContent: "center", backgroundColor: ds.brassDeep },
  applyText: { color: "#fff", fontFamily: font.semibold, fontWeight: "600", fontSize: 12 },
});
