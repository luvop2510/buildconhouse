import React from "react";
import { Platform, StyleProp, View, ViewStyle } from "react-native";
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
  bottomNavigationHidden = false,
  style,
  testID,
  phoneSafeArea = true,
}: {
  children: React.ReactNode;
  bottomNavigation: React.ReactNode;
  bottomNavigationHidden?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  phoneSafeArea?: boolean;
}) {
  return (
    <SafeAreaView
      testID={testID}
      edges={phoneSafeArea ? ["top", "left", "right"] : []}
      style={[{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden", backgroundColor: color.canvas }, style]}
    >
      <View role="main" accessibilityLabel="Workspace content" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>{children}</View>
      {bottomNavigation ? <SafeAreaView
        edges={["bottom"]}
        pointerEvents={bottomNavigationHidden ? "none" : "auto"}
        accessibilityElementsHidden={bottomNavigationHidden}
        importantForAccessibility={bottomNavigationHidden ? "no-hide-descendants" : "auto"}
        aria-hidden={bottomNavigationHidden}
        // Keep navigation mounted without reserving an invisible band above the keyboard.
        style={[{ backgroundColor: color.canvas, borderTopWidth: layout.hairline, borderTopColor: color.line }, bottomNavigationHidden ? { opacity: 0, position: "absolute", top: "100%", left: 0, right: 0, ...(Platform.OS === "web" ? { visibility: "hidden" } : {}) } as ViewStyle : null]}
      >
        {bottomNavigation}
      </SafeAreaView> : null}
    </SafeAreaView>
  );
}
