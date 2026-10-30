import React from 'react';
import { View, Pressable, type StyleProp, type ViewStyle } from "react-native";
import { Text } from "@/src/components/AppText";
import { color, font, layout, radius, space, statusTone, toneColor, type Tone } from './tokens';
import { Txt, Hairline } from './typography';
import { webCursor } from './shared';
import { useBp } from './responsive';

export function StatusWord({ status, tone, label }: { status?: string; tone?: Tone; label?: string }) {
  const meta = status ? statusTone[status] : undefined;
  const t = tone ?? meta?.tone ?? "neutral";
  const l = label ?? meta?.label ?? status ?? "—";
  const c = toneColor[t];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.dot }} />
      <Text style={{ fontFamily: font.medium, fontWeight: "500", fontSize: 12.5, color: c.fg }}>{l}</Text>
    </View>
  );
}

// ═════════════════════════════════════════════ Avatar ═══════════════════════
export function Avatar({ name, size = 34 }: { name?: string | null; size?: number }) {
  const initials = (name || "?")
    .split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  return (
    <View
      style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: color.sunkenDeep, alignItems: "center", justifyContent: "center",
      }}
    >
      <Text style={{
        fontFamily: font.semibold, fontWeight: "600",
        fontSize: Math.round(size * 0.36), color: color.inkMid, letterSpacing: 0.3,
      }}>
        {initials}
      </Text>
    </View>
  );
}

// ═════════════════════════════════════════════ Surface / Section ════════════
export function Surface({
  children, pad, style,
}: { children: React.ReactNode; pad?: number; style?: StyleProp<ViewStyle> }) {
  const { isPhone, isDesktop } = useBp();
  return (
    <View style={[{
      backgroundColor: color.surface, borderRadius: radius.lg, padding: pad ?? (isDesktop ? space.x5 : isPhone ? space.x3 : space.x4), minWidth: 0,
      borderWidth: layout.hairline, borderColor: color.line,
    }, style]}
    >
      {children}
    </View>
  );
}

export function Section({
  eyebrow, right, style,
}: { eyebrow: string; right?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, style]}>
      <Txt v="eyebrow">{eyebrow}</Txt>
      {right}
    </View>
  );
}

// ═════════════════════════════════════════════ Row ══════════════════════════
export function Row({
  onPress, children, divider, pad = space.x4, minHeight = 56, testID, style,
}: {
  onPress?: () => void;
  children: React.ReactNode;
  divider?: boolean;
  pad?: number;
  minHeight?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <>
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={!onPress}
        style={({ pressed, hovered }: any) => [
          {
            flexDirection: "row", alignItems: "center", gap: space.x3,
            paddingVertical: pad, minHeight,
            marginHorizontal: -space.x3, paddingHorizontal: space.x3, borderRadius: radius.md,
            backgroundColor: onPress && (pressed || hovered) ? color.hoverWash : "transparent",
          },
          onPress ? webCursor : null,
          style,
        ]}
      >
        {children}
      </Pressable>
      {divider ? <Hairline /> : null}
    </>
  );
}
