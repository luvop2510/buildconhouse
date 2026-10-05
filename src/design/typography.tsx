import React from 'react';
import { View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import { Text } from "@/src/components/AppText";
import { color, fmtMoney, fmtMoneyCompact, font, layout, text } from './tokens';

type TxtVariant = keyof typeof text;
export function Txt({
  v = "body", tone, style, numberOfLines, children, selectable,
}: {
  v?: TxtVariant;
  tone?: "ink" | "mid" | "soft" | "faint" | "ok" | "warn" | "risk" | "brass" | "onAction";
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  selectable?: boolean;
  children: React.ReactNode;
}) {
  const toneColorMap = {
    ink: color.ink, mid: color.inkMid, soft: color.inkSoft, faint: color.inkFaint,
    ok: color.ok, warn: color.warn, risk: color.risk, brass: color.brassDeep,
    onAction: color.onAction,
  } as const;
  return (
    <Text
      numberOfLines={numberOfLines}
      selectable={selectable}
      accessibilityRole={v === "title" || v === "heading" || v.startsWith("display") ? "header" : undefined}
      style={[text[v] as TextStyle, tone ? { color: toneColorMap[tone] } : null, style]}
    >
      {children}
    </Text>
  );
}

// ═════════════════════════════════════════════ Money ════════════════════════
// ₹ rendered smaller & softer than the digits — the amount is the message.
export function Money({
  value, size = "md", compact, tone, style,
}: {
  value: number;
  size?: "xl" | "lg" | "md" | "sm";
  compact?: boolean;
  tone?: "ink" | "mid" | "soft" | "ok" | "risk";
  style?: StyleProp<TextStyle>;
}) {
  const base =
    size === "xl" ? text.moneyXl : size === "lg" ? text.moneyLg :
    size === "sm" ? text.moneySm : text.money;
  const symbolSize = size === "xl" ? 19 : size === "lg" ? 15 : size === "sm" ? 11 : 12;
  const fg =
    tone === "mid" ? color.inkMid : tone === "soft" ? color.inkSoft :
    tone === "ok" ? color.ok : tone === "risk" ? color.risk : color.ink;
  return (
    <Text style={[base as TextStyle, { color: fg }, style]}>
      <Text style={{ fontSize: symbolSize, color: tone ? fg : color.inkSoft, fontFamily: font.regular }}>₹</Text>
      {compact ? fmtMoneyCompact(value) : fmtMoney(value)}
    </Text>
  );
}

// ═════════════════════════════════════════════ Hairline ═════════════════════
export function Hairline({ style, vertical }: { style?: StyleProp<ViewStyle>; vertical?: boolean }) {
  return (
    <View
      style={[
        vertical
          ? { width: layout.hairline, alignSelf: "stretch", backgroundColor: color.line }
          : { height: layout.hairline, alignSelf: "stretch", backgroundColor: color.line },
        style,
      ]}
    />
  );
}
