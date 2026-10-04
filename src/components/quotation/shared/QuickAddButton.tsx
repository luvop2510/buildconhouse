// QuickAddButton — shared "Add to quotation" micro-interaction used by every
// product-picker surface (ProductExplorer grid cards, PickerCard rows).
// Fixes the "adding a product gives poor feedback" complaint: on tap it
// (1) fires the caller's onAdd, (2) flashes a brief checkmark + colour swap
// directly on the button, and (3) surfaces a bottom toast
// — all non-blocking, the picker/grid stays exactly where it was so the
// browsing workflow is never interrupted.
import Feather from "@expo/vector-icons/Feather";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";

import { toast } from "@/src/components/Toast";
import { colors, radius } from "@/src/theme/tokens";

type Props = {
  onAdd: () => void;
  toastText?: string;
  idleLabel?: string;
  addedLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /** Round icon-only variant (used inline in list rows like PickerCard). */
  circular?: boolean;
  circularSize?: number;
  iconSize?: number;
};

const FLASH_MS = 900;

export function QuickAddButton({
  onAdd, toastText, idleLabel = "Add", addedLabel = "Added",
  style, testID, circular, circularSize = 28, iconSize,
}: Props) {
  const [justAdded, setJustAdded] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  const addLocked = useRef(false);

  useEffect(() => () => {
    mounted.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const handlePress = (event?: { stopPropagation?: () => void }) => {
    // Picker rows are also pressable. Stop the nested control from becoming
    // a second add on web, then briefly lock it while the success state is
    // visible so an impatient double-tap cannot add two line items.
    event?.stopPropagation?.();
    if (justAdded || addLocked.current) return;
    addLocked.current = true;
    onAdd();
    Haptics.selectionAsync();
    if (toastText) toast.success(toastText);
    setJustAdded(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      addLocked.current = false;
      if (mounted.current) setJustAdded(false);
    }, FLASH_MS);
  };

  if (circular) {
    return (
      <Pressable
        accessibilityRole="button" accessibilityLabel={justAdded ? addedLabel : "Add product"}
        hitSlop={8}
        onPress={handlePress}
        testID={testID}
        style={[
          stylesCircular.wrap,
          { width: circularSize, height: circularSize, borderRadius: circularSize / 2 },
          justAdded && stylesCircular.wrapAdded,
          style,
        ]}
      >
        <View>
          <Feather name={justAdded ? "check" : "plus"} size={iconSize ?? 16} color={colors.onBrand} />
        </View>
      </Pressable>
    );
  }

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={justAdded ? addedLabel : idleLabel} onPress={handlePress} testID={testID} style={[styles.addBtn, justAdded && styles.addBtnAdded, style]}>
      <View style={styles.addBtnInner}>
        <Feather name={justAdded ? "check" : "plus"} size={iconSize ?? 13} color={colors.onBrand} />
        <Text style={styles.addLabel} numberOfLines={1}>{justAdded ? addedLabel : idleLabel}</Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  addBtn: {
    flexShrink: 0, paddingHorizontal: 9, paddingVertical: 6, borderRadius: radius.sm,
    backgroundColor: colors.brand,
  },
  addBtnAdded: { backgroundColor: colors.success },
  addBtnInner: { flexDirection: "row", alignItems: "center", gap: 4 },
  addLabel: { fontSize: 13, fontWeight: "700", color: colors.onBrand, letterSpacing: 0.2 },
});

const stylesCircular = StyleSheet.create({
  wrap: { backgroundColor: colors.brand, alignItems: "center", justifyContent: "center" },
  wrapAdded: { backgroundColor: colors.success },
});
