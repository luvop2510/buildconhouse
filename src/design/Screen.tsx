// Screen — the one page scaffold. Consistent gutters, max width, header rhythm.
import { useRouter } from "expo-router";
import React from "react";
import { ScrollView, View } from "react-native";

import { PageHeader } from "./PageHeader";
import { useBp } from "./responsive";
import { color, layout, space } from "./tokens";

export function Screen({
  title, eyebrow, sub, back, actions, children,
  scroll = true, maxWidth = layout.content, header = true,
}: {
  title?: string;
  eyebrow?: string;
  sub?: string;
  back?: boolean;
  actions?: React.ReactNode;
  children: React.ReactNode;
  scroll?: boolean;
  maxWidth?: number;
  header?: boolean;
}) {
  const { gutter, isDesktop } = useBp();
  const router = useRouter();

  const headerBlock = header && (title || actions) ? <PageHeader embedded
    title={title || ""} overline={eyebrow} subtitle={sub}
    back={back ? () => router.back() : undefined} actions={actions} /> : null;

  const inner = (
    <View style={{
      width: "100%", maxWidth, alignSelf: "center",
      paddingHorizontal: gutter, flexGrow: 1, minWidth: 0, minHeight: 0,
    }}>
      {headerBlock}
      {children}
    </View>
  );

  if (!scroll) {
    return (
      <View style={{ flex: 1, backgroundColor: color.canvas }}>
        {inner}
      </View>
    );
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: color.canvas }}
      contentContainerStyle={{ paddingBottom: isDesktop ? space.x16 : space.x6, flexGrow: 1 }}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      {inner}
    </ScrollView>
  );
}
