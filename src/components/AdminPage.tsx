// Reusable page frame for logged-in screens.
// Now composed on top of the shared PageHeader primitive so every AdminPage
// gets identical chrome (title + overline + subtitle + action cluster + optional
// back). No hardcoded typography or spacing anywhere.
//
// Also exposes IconAction for right-cluster buttons (unchanged API for callers).
import Feather from "@expo/vector-icons/Feather";
import { Pressable, ScrollView, StyleSheet, View, ViewStyle } from "react-native";
import type { Ref } from "react";
import { Text } from "@/src/components/AppText";

import { PageHeader } from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { color, font, layout, radius, space } from "@/src/design/tokens";

export function AdminPage({
  title,
  subtitle,
  overline,
  right,
  back,
  children,
  scroll = true,
  contentStyle,
}: {
  title: string;
  subtitle?: string | null;
  overline?: string;
  right?: React.ReactNode;
  back?: () => void;
  children: React.ReactNode;
  scroll?: boolean;
  contentStyle?: ViewStyle;
  /** @deprecated — header now always uses a subtle divider */
  headerBorder?: boolean;
}) {
  const Container: any = scroll ? ScrollView : View;
  const { gutter, isPhone } = useBp();
  const horizontalPadding = gutter;

  return (
    <View style={{ flex: 1, minHeight: 0, backgroundColor: color.canvas }}>
      <PageHeader
        title={title}
        subtitle={subtitle || undefined}
        overline={overline}
        back={back}
        actions={right}
      />
      <Container
        {...(scroll
          ? {
              showsVerticalScrollIndicator: false,
              keyboardShouldPersistTaps: "handled",
              style: { flex: 1, minHeight: 0 },
              contentContainerStyle: {
                paddingHorizontal: horizontalPadding,
                paddingTop: isPhone ? space.x4 : space.x8,
                // AppScaffold reserves navigation/safe-area space outside this scroll.
                paddingBottom: isPhone ? space.x6 : space.x16,
                gap: isPhone ? space.x4 : space.x5,
                ...contentStyle,
              },
            }
          : {
              style: [
                {
                  flex: 1,
                  paddingHorizontal: horizontalPadding,
                  paddingTop: isPhone ? space.x4 : space.x8,
                },
                contentStyle,
              ],
            })}
      >
        {children}
      </Container>
    </View>
  );
}

// Icon-only tappable in a page header's right cluster. Kept exported for
// backwards-compat with older screens. Renders a bordered 40x40 tile with
// centered icon + optional label chip. Uses tokens only.
export function IconAction({
  icon, label, onPress, testID, tone = "surface", focusRef,
}: {
  icon: keyof typeof Feather.glyphMap;
  label?: string;
  onPress: () => void;
  testID?: string;
  tone?: "surface" | "brand";
  focusRef?: Ref<View>;
}) {
  const isBrand = tone === "brand";
  return (
    <Pressable
      ref={focusRef}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label || icon.replace(/-/g, " ")}
      onPress={onPress}
      style={({ pressed }) => [{
        flexDirection: "row",
        alignItems: "center",
        gap: space.x2,
        height: layout.tap,
        paddingHorizontal: label ? space.x4 : 0,
        width: label ? undefined : Math.max(44, 40),
        minHeight: 44,
        borderRadius: radius.md,
        backgroundColor: isBrand ? color.action : color.surface,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: isBrand ? color.action : color.line,
        opacity: pressed ? 0.88 : 1,
        justifyContent: "center",
      }]}
    >
      <Feather name={icon} size={16} color={isBrand ? color.onAction : color.ink} />
      {label ? (
        <Text style={{
          fontSize: 13,
          fontFamily: font.semibold,
          fontWeight: "600",
          color: isBrand ? color.onAction : color.ink,
        }}>{label}</Text>
      ) : null}
    </Pressable>
  );
}
