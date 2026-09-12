// Shared layout atoms for legal/policy documents (Privacy Policy, Terms of
// Service) — kept separate so both documents render with identical
// typography without duplicating the same two components twice.
import { Text, View } from "react-native";

import { color, font } from "@/src/design/tokens";

export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={{ fontFamily: font.medium, fontSize: 17, color: color.ink }}>{title}</Text>
      {children}
    </View>
  );
}

export function P({ children }: { children: React.ReactNode }) {
  return (
    <Text style={{ fontFamily: font.regular, fontSize: 15, lineHeight: 24, color: color.inkMid }}>
      {children}
    </Text>
  );
}
