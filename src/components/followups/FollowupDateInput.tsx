import { createElement, useId } from "react";
import { Platform, View } from "react-native";

import { Text } from "@/src/components/AppText";
import { TextField } from "@/src/components/ds";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

export function FollowupDateInput({ label, value, onChange, min, disabled, required, testID }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  min?: string;
  disabled?: boolean;
  required?: boolean;
  testID?: string;
}) {
  const id = useId();
  if (Platform.OS !== "web") {
    return <TextField label={label} value={value} onChangeText={onChange} editable={!disabled}
      accessibilityHint="Enter the date as year, month, and day in India time."
      placeholder="YYYY-MM-DD" maxLength={10} testID={testID} />;
  }
  return (
    <View style={{ gap: spacing.sm }}>
      <Text nativeID={id + "-label"} style={type.label}>{label}</Text>
      {createElement("input", {
        type: "date", value, min, disabled, required,
        "aria-labelledby": id + "-label", "data-testid": testID,
        onChange: (event: { target: { value: string } }) => onChange(event.target.value),
        style: {
          boxSizing: "border-box", width: "100%", minWidth: 0, minHeight: 48,
          padding: "8px 12px", border: `1px solid ${colors.controlBorder}`, borderRadius: radius.md,
          background: colors.surfaceSecondary, color: colors.onSurface, fontFamily: "inherit", fontSize: 16,
        },
      })}
    </View>
  );
}
