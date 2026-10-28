import Feather from "@expo/vector-icons/Feather";
import { useEffect, useState, type ReactNode } from "react";
import { Pressable, StyleSheet, View, type ViewStyle } from "react-native";
import Svg, { Defs, LinearGradient, Rect, Stop } from "react-native-svg";

import { Text } from "@/src/components/AppText";
import { color, font, space } from "@/src/design/tokens";
import { storage } from "@/src/utils/storage";

/** Native/web adaptation of the supplied banner template; layout stays in flow. */
export function Banner({ id, message, children, variant = "normal", height = 48, style }: {
  id?: string;
  message?: string;
  children?: ReactNode;
  variant?: "normal" | "rainbow";
  height?: number;
  style?: ViewStyle;
}) {
  const [closedId, setClosedId] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    if (id) void storage.getItem(`banner-${id}`, false).then(closed => {
      if (current) setClosedId(previous => closed || previous === id ? id : null);
    });
    return () => { current = false; };
  }, [id]);
  if (id && closedId === id) return null;

  return <View testID={id ? `banner-${id}` : undefined} style={[{
    position: "relative", overflow: "hidden", minHeight: height,
    flexDirection: "row", alignItems: "center", gap: space.x2,
    paddingLeft: space.x4, paddingRight: id ? space.x1 : space.x4,
    paddingVertical: space.x1, borderRadius: 8,
    backgroundColor: color.sunken, borderWidth: 1, borderColor: color.line,
  }, style]}>
    {variant === "rainbow" ? <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={StyleSheet.absoluteFill}>
      <Svg width="100%" height="100%"><Defs><LinearGradient id="banner-spectrum" x1="0" y1="0" x2="1" y2="1"><Stop offset="0" stopColor={color.accentTint} /><Stop offset="0.5" stopColor={color.surface} /><Stop offset="1" stopColor={color.warnTint} /></LinearGradient></Defs><Rect width="100%" height="100%" fill="url(#banner-spectrum)" /></Svg>
    </View> : null}
    <View style={{ flex: 1, minWidth: 0 }}>
      {message ? <Text style={{ fontFamily: font.regular, fontSize: 13, lineHeight: 20, color: color.inkMid }}>{message}</Text> : children}
    </View>
    {id ? <Pressable accessibilityRole="button" accessibilityLabel="Close banner" testID={`banner-${id}-dismiss`} onPress={() => {
      setClosedId(id);
      void storage.setItem(`banner-${id}`, true);
    }} style={({ pressed, hovered }) => ({ width: 44, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 8, backgroundColor: pressed || hovered ? color.pressWash : "transparent" })}>
      <Feather name="x" size={16} color={color.inkMid} />
    </Pressable> : null}
  </View>;
}
