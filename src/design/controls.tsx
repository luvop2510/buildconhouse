import React from 'react';
import Feather from '@expo/vector-icons/Feather';
import { ActivityIndicator, Pressable, type ViewStyle } from "react-native";
import { Text } from "@/src/components/AppText";
import { color, control, font, layout, radius } from './tokens';
import { webCursor, type FeatherName } from './shared';

export function Button({
  label, onPress, variant = "primary", size = "md", icon, iconRight, loading, disabled, full, testID, style,
}: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger" | "brandLight" | "outline";
  size?: "sm" | "md" | "lg";
  icon?: FeatherName;
  iconRight?: FeatherName;
  style?: ViewStyle;
  loading?: boolean;
  disabled?: boolean;
  full?: boolean;
  testID?: string;
}) {
  const h = control.height[size];
  const px = control.inset[size];
  const fs = control.label[size];
  const iconPx = control.icon[size];
  const btnRadius = radius.md;
  const dim = disabled || loading;

  const face = (pressed: boolean, hovered: boolean): ViewStyle => {
    switch (variant) {
      case "primary":
        return { backgroundColor: pressed || hovered ? color.actionHover : color.action };
      case "secondary":
        return {
          backgroundColor: pressed ? color.sunken : hovered ? color.canvas : color.surface,
          borderWidth: 1, borderColor: hovered ? color.lineStrong : color.line,
        };
      case "brandLight":
        return { backgroundColor: color.accentTint, borderWidth: 1, borderColor: color.accentBorder };
      case "outline":
        return { backgroundColor: "transparent", borderWidth: 1, borderColor: color.action };
      case "danger":
        return { backgroundColor: pressed || hovered ? "#983F33" : color.risk };
      default: // ghost
        return { backgroundColor: pressed ? color.pressWash : hovered ? color.hoverWash : "transparent" };
    }
  };
  const fg = variant === "primary" || variant === "danger" ? color.onAction
    : variant === "outline" || variant === "brandLight" ? color.action : variant === "ghost" ? color.inkMid : color.ink;

  return (
    <Pressable
      testID={testID}
      onPress={dim ? undefined : onPress}
      disabled={dim}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: dim }}
      style={({ pressed, hovered }: any) => [
        {
          minHeight: h, paddingVertical: 12, paddingHorizontal: px, borderRadius: btnRadius,
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
          opacity: dim ? 0.45 : 1,
          minWidth: 0, maxWidth: "100%",
          alignSelf: full ? "stretch" : "flex-start",
        },
        face(!!pressed, !!hovered),
        webCursor,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : icon ? (
        <Feather accessible={false} name={icon} size={iconPx} color={fg} />
      ) : null}
      <Text style={{ fontFamily: font.semibold, fontWeight: "600", fontSize: fs, color: fg, letterSpacing: -0.1, flexShrink: 1, textAlign: "center" }}>
        {label}
      </Text>
      {iconRight && !loading ? <Feather accessible={false} name={iconRight} size={iconPx} color={fg} /> : null}
    </Pressable>
  );
}

export function IconButton({
  icon, onPress, size = 44, iconSize, tone = "mid", label, testID,
}: {
  icon: FeatherName;
  onPress?: () => void;
  size?: number;
  iconSize?: number;
  tone?: "ink" | "mid" | "soft" | "onAction" | "risk";
  label?: string;
  testID?: string;
}) {
  const fg = tone === "ink" ? color.ink : tone === "soft" ? color.inkSoft
    : tone === "onAction" ? color.onAction : tone === "risk" ? color.risk : color.inkMid;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label || icon.replace(/-/g, " ")}
      onPress={onPress}
      hitSlop={layout.hitSlop}
      style={({ pressed, hovered }: any) => [
        {
          width: Math.max(size, layout.tap), height: Math.max(size, layout.tap), borderRadius: radius.md,
          alignItems: "center", justifyContent: "center",
          backgroundColor: pressed ? color.pressWash : hovered ? color.hoverWash : "transparent",
        },
        webCursor,
      ]}
    >
      <Feather accessible={false} name={icon} size={iconSize ?? control.icon.lg} color={fg} />
    </Pressable>
  );
}
