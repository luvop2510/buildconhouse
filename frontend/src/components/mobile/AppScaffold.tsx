import React from "react";
import { StyleProp, View, ViewStyle } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { color, layout } from "@/src/design/tokens";

/**
 * The phone application frame. It is the only owner of persistent safe-area
 * chrome and bottom-navigation placement; route screens own one scrollable
 * content region inside `children` and must not add another top safe area.
 */
export function AppScaffold({
  children,
  bottomNavigation,
  style,
  testID,
}: {
  children: React.ReactNode;
  bottomNavigation: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  return (
    <SafeAreaView
      testID={testID}
      edges={["top", "left", "right"]}
      style={[{ flex: 1, minWidth: 0, backgroundColor: color.canvas }, style]}
    >
      <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{children}</View>
      {bottomNavigation ? <SafeAreaView
        edges={["bottom"]}
        style={{ backgroundColor: color.canvas, borderTopWidth: layout.hairline, borderTopColor: color.line }}
      >
        {bottomNavigation}
      </SafeAreaView> : null}
    </SafeAreaView>
  );
}
