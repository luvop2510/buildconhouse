import Feather from "@expo/vector-icons/Feather";
import { type ReactNode, useId, useState } from "react";
import { Pressable, View, type StyleProp, type ViewStyle } from "react-native";

import { Text } from "@/src/components/AppText";
import { colors, spacing, type } from "@/src/theme/tokens";

/** Hide grouped filters at any width without clearing selections or drafts. */
export function MobileFilterSection({ children, testID, style, initiallyExpanded = true }: {
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  initiallyExpanded?: boolean;
}) {
  const contentId = useId();
  const [expanded, setExpanded] = useState(initiallyExpanded);
  return (
    <View testID={testID} style={style}>
      <Pressable
        testID={testID ? `${testID}-toggle` : undefined}
        accessibilityRole="button"
        accessibilityState={{ expanded }}
        aria-expanded={expanded}
        aria-controls={contentId}
        onPress={() => setExpanded(value => !value)}
        style={{ minHeight: 44, flexDirection: "row", alignItems: "center", gap: spacing.sm, alignSelf: "flex-start" }}
      >
        <Feather name={expanded ? "chevron-up" : "sliders"} size={16} color={colors.onSurfaceSecondary} />
        <Text style={type.captionStrong}>{expanded ? "Hide filters" : "Show filters"}</Text>
      </Pressable>
      <View
        nativeID={contentId}
        testID={testID ? `${testID}-content` : undefined}
        style={{ gap: spacing.md, display: expanded ? "flex" : "none" }}
      >
        {children}
      </View>
    </View>
  );
}
