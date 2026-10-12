// Discount sheet — project / category / line discount management.
import Feather from "@expo/vector-icons/Feather";
import { useLayoutEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { BottomSheet } from "@/src/components/BottomSheet";
import { Button } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

import { useBuilder } from "../context/BuilderContext";
import { effectivePct } from "../helpers/pricing";

export function DiscountSheet() {
  const b = useBuilder();
  const cur = b.discountSheet;
  const close = () => b.setDiscountSheet(null);

  const [tempProjPct, setTempProjPct] = useState<string>("0");
  const [tempLinePct, setTempLinePct] = useState<string>("");
  const [tempCatPct, setTempCatPct] = useState<string>("");
  const [roomType, setRoomType] = useState<"percent" | "amount">("percent");
  const [tempRoomVal, setTempRoomVal] = useState<string>("");

  // Initialize before the sheet becomes interactive. A passive effect can
  // replace the selected text after typing begins, appending the new digits
  // to the saved discount instead of replacing it during rapid edits.
  useLayoutEffect(() => {
    if (!cur) return;
    if (cur.kind === "project") setTempProjPct(String(b.s.projectDiscount));
    else if (cur.kind === "line") {
      const l = b.s.lines.find((x) => x.id === cur.line_id);
      setTempLinePct(l?.discount_pct != null ? String(l.discount_pct) : "");
    } else if (cur.kind === "category") {
      setTempCatPct(b.s.categoryDiscounts[cur.category_id] != null ? String(b.s.categoryDiscounts[cur.category_id]) : "");
    } else if (cur.kind === "room") {
      const rd = b.s.roomDiscounts[cur.room];
      setRoomType(rd?.type || "percent");
      setTempRoomVal(rd ? String(rd.value) : "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur]);

  const apply = () => {
    if (!cur) return;
    if (cur.kind === "project") b.setProjectDiscount(Number(tempProjPct) || 0);
    else if (cur.kind === "line") {
      b.updateLine(cur.line_id, {
        discount_pct: tempLinePct === "" ? null : Math.max(0, Math.min(100, Number(tempLinePct) || 0)),
      });
    } else if (cur.kind === "category") {
      b.setCategoryDiscount(cur.category_id, tempCatPct === "" ? null : Number(tempCatPct) || 0);
    } else if (cur.kind === "room") {
      const val = Number(tempRoomVal) || 0;
      b.setRoomDiscount(cur.room, tempRoomVal === "" || val <= 0 ? null : { type: roomType, value: val });
    }
    close();
  };

  const currentLine = cur?.kind === "line" ? b.s.lines.find((l) => l.id === cur.line_id) : null;
  const currentLineEff = currentLine ? effectivePct(currentLine, b.s.roomDiscounts, b.s.categoryDiscounts, b.s.projectDiscount) : null;

  return (
    <BottomSheet
      visible={!!cur}
      onClose={close}
      title={cur?.kind === "line" ? "Item discount" : cur?.kind === "category" ? "Category discount" : cur?.kind === "room" ? "Room discount" : "Discounts"}
      testID="discount-sheet"
      footer={
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button label="Cancel" variant="secondary" onPress={close} />
          <Button label="Apply" onPress={apply} testID="apply-discount" />
        </View>
      }
    >
      {cur?.kind === "project" ? (
        <View style={{ gap: spacing.lg }}>
          <View style={{ gap: 6 }}>
            <Text style={type.overline}>Project-wide %</Text>
            <TextInput
              testID="project-disc-input"
              value={tempProjPct}
              onChangeText={setTempProjPct}
              keyboardType="decimal-pad"
              placeholder="0"
              style={styles.bigInput}
            />
            <Text style={type.caption}>Applied to items that do not have a closer-scoped override.</Text>
          </View>

          <View style={{ gap: 8 }}>
            <Text style={type.overline}>Category overrides</Text>
            {b.usedCategoryIds.length === 0 ? (
              <Text style={type.caption}>Add products first — categories used will appear here.</Text>
            ) : b.usedCategoryIds.map((cid) => (
              <Pressable
                key={cid}
                testID={`edit-cat-${cid}`}
                onPress={() => b.setDiscountSheet({ kind: "category", category_id: cid })}
                style={styles.catRow}
              >
                <Text style={{ flex: 1, fontSize: 13, fontWeight: "600" }}>{b.categoryById[cid] || "—"}</Text>
                <Text style={[type.numeric, { fontSize: 13, lineHeight: 18 }]}>
                  {b.s.categoryDiscounts[cid] != null ? `${b.s.categoryDiscounts[cid]}%` : "Add discount"}
                </Text>
                <Feather name={b.s.categoryDiscounts[cid] != null ? "edit-2" : "plus"} size={14} color={colors.brand} />
              </Pressable>
            ))}
          </View>

          <View style={{ gap: 8 }}>
            <Text style={type.overline}>Room overrides</Text>
            {b.s.rooms.length === 0 ? (
              <Text style={type.caption}>Add a room first.</Text>
            ) : b.s.rooms.map((room) => {
              const rd = b.s.roomDiscounts[room];
              return (
                <Pressable
                  key={room}
                  testID={`edit-room-disc-${room}`}
                  onPress={() => b.setDiscountSheet({ kind: "room", room })}
                  style={styles.catRow}
                >
                  <Text style={{ flex: 1, fontSize: 13, fontWeight: "600" }} numberOfLines={1}>{room}</Text>
                  <Text style={[type.numeric, { fontSize: 13, lineHeight: 18 }]}>
                    {rd ? (rd.type === "percent" ? `${rd.value}%` : `₹${rd.value.toLocaleString("en-IN")}`) : "Add discount"}
                  </Text>
                  <Feather name={rd ? "edit-2" : "plus"} size={14} color={colors.brand} />
                </Pressable>
              );
            })}
          </View>

          <View style={styles.callout}>
            <Text style={type.overline}>How it stacks</Text>
            <Text style={type.caption}>
              Product override → Room → Category → Project. The first closer-scoped discount wins per item.
            </Text>
          </View>
        </View>
      ) : cur?.kind === "category" ? (
        <View style={{ gap: spacing.md }}>
          <Text style={type.body}>{b.categoryById[cur.category_id] || "Category"}</Text>
          <TextInput
            testID="category-disc-input"
            value={tempCatPct}
            onChangeText={setTempCatPct}
            keyboardType="decimal-pad"
            placeholder="Leave empty to remove"
            style={styles.bigInput}
          />
          <Text style={type.caption}>Applied to all items in this category, unless the item or its room has a closer-scoped override.</Text>
        </View>
      ) : cur?.kind === "room" ? (
        <View style={{ gap: spacing.md }}>
          <Text style={type.body}>{cur.room}</Text>
          <View style={styles.typeToggle}>
            <Pressable
              testID="room-disc-type-percent"
              onPress={() => setRoomType("percent")}
              style={[styles.typeBtn, roomType === "percent" && styles.typeBtnActive]}
            >
              <Text style={[styles.typeBtnLabel, roomType === "percent" && styles.typeBtnLabelActive]}>Percent %</Text>
            </Pressable>
            <Pressable
              testID="room-disc-type-amount"
              onPress={() => setRoomType("amount")}
              style={[styles.typeBtn, roomType === "amount" && styles.typeBtnActive]}
            >
              <Text style={[styles.typeBtnLabel, roomType === "amount" && styles.typeBtnLabelActive]}>Flat ₹</Text>
            </Pressable>
          </View>
          <TextInput
            testID="room-disc-input"
            value={tempRoomVal}
            onChangeText={setTempRoomVal}
            keyboardType="decimal-pad"
            placeholder={roomType === "percent" ? "e.g. 10" : "e.g. 5000"}
            style={styles.bigInput}
          />
          <Text style={type.caption}>
            {roomType === "percent"
              ? "Every item in this room gets this % off, unless it has its own product-level override."
              : "This flat amount is split proportionally across every item in this room (capped at the room's subtotal)."}
          </Text>
        </View>
      ) : cur?.kind === "line" && currentLine ? (
        <View style={{ gap: spacing.md }}>
          <Text style={type.body}>{currentLine.name}</Text>
          <TextInput
            testID="line-disc-input"
            value={tempLinePct}
            onChangeText={setTempLinePct}
            keyboardType="decimal-pad"
            placeholder="Empty → inherit from room / category / project"
            style={styles.bigInput}
          />
          {currentLineEff && currentLineEff.source !== "none" && currentLine.discount_pct == null ? (
            <View style={styles.callout}>
              <Text style={type.overline}>Currently inheriting</Text>
              <Text style={type.body}>{Math.round(currentLineEff.pct * 100) / 100}% from {currentLineEff.source.replace("_amount", "")}</Text>
            </View>
          ) : null}
        </View>
      ) : null}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  bigInput: {
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.onSurface,
  },
  catRow: {
    flexDirection: "row", alignItems: "center", gap: 10, padding: 10, backgroundColor: colors.surface,
    borderRadius: radius.md, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  callout: { padding: 12, borderRadius: radius.md, backgroundColor: colors.surfaceTertiary, gap: 4 },
  typeToggle: { flexDirection: "row", gap: 6, backgroundColor: colors.surfaceTertiary, padding: 3, borderRadius: radius.md },
  typeBtn: { flex: 1, paddingVertical: 8, alignItems: "center", borderRadius: radius.sm },
  typeBtnActive: { backgroundColor: colors.surface },
  typeBtnLabel: { fontSize: 12, fontWeight: "600", color: colors.onSurfaceSecondary },
  typeBtnLabelActive: { color: colors.onSurface },
});
