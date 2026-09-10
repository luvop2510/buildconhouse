// QuickAddButton — shared "Add to quotation" micro-interaction used by every
// product-picker surface (ProductExplorer grid cards, PickerCard rows).
// Fixes the "adding a product gives poor feedback" complaint: on tap it
// (1) fires the caller's onAdd, (2) flashes a brief checkmark + colour swap
// directly on the button with a spring pop, and (3) surfaces a bottom toast
// — all non-blocking, the picker/grid stays exactly where it was so the
// browsing workflow is never interrupted.
import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useEffect, useRef, useState } from "react";
import { Animated, Pressable, StyleSheet, Text, type StyleProp, type ViewStyle } from "react-native";

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
  const scale = useRef(new Animated.Value(1)).current;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);

  useEffect(() => () => {
    mounted.current = false;
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const handlePress = () => {
    onAdd();
    Haptics.selectionAsync();
    if (toastText) toast.success(toastText);
    setJustAdded(true);
    scale.setValue(1);
    Animated.sequence([
      Animated.spring(scale, { toValue: 1.22, useNativeDriver: true, speed: 40, bounciness: 12 }),
      Animated.spring(scale, { toValue: 1, useNativeDriver: true, speed: 24, bounciness: 6 }),
    ]).start();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => { if (mounted.current) setJustAdded(false); }, FLASH_MS);
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
        <Animated.View style={{ transform: [{ scale }] }}>
          <Feather name={justAdded ? "check" : "plus"} size={iconSize ?? 16} color={colors.onBrand} />
        </Animated.View>
      </Pressable>
    );
  }

  return (
    <Pressable accessibilityRole="button" accessibilityLabel={justAdded ? addedLabel : idleLabel} onPress={handlePress} testID={testID} style={[styles.addBtn, justAdded && styles.addBtnAdded, style]}>
      <Animated.View style={[styles.addBtnInner, { transform: [{ scale }] }]}>
        <Feather name={justAdded ? "check" : "plus"} size={iconSize ?? 13} color={colors.onBrand} />
        <Text style={styles.addLabel} numberOfLines={1}>{justAdded ? addedLabel : idleLabel}</Text>
      </Animated.View>
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
