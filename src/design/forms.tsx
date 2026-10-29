import React, { createContext, useContext, useState, useId } from 'react';
import { View, Platform } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";
import { color, control, font, radius, space } from './tokens';
import { Txt } from './typography';

const FieldLabelContext = createContext<{ label?: string; description?: string; invalid?: boolean }>({});
export function Field({
  label, error, helper, children,
}: { label?: string; error?: string | null; helper?: string; children: React.ReactNode }) {
  const description = useId();
  return (
    <View style={{ gap: space.x2 }}>
      {label ? <Txt v="caption" tone="mid">{label}</Txt> : null}
      <FieldLabelContext.Provider value={{ label, description: error || helper ? description : undefined, invalid: !!error }}>{children}</FieldLabelContext.Provider>
      {error ? <Text nativeID={description} accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ color: color.risk, fontFamily: font.regular, fontSize: 12 }}>{error}</Text>
        : helper ? <Text nativeID={description} style={{ fontSize: 12, color: color.inkSoft }}>{helper}</Text> : null}
    </View>
  );
}

export const Input = React.forwardRef<TextInput, React.ComponentProps<typeof TextInput> & {
  invalid?: boolean; right?: React.ReactNode; left?: React.ReactNode;
}>(function Input({ invalid, right, left, style, onFocus, onBlur, ...rest }, ref) {
  const [focused, setFocused] = useState(false);
  const field = useContext(FieldLabelContext);
  invalid = invalid || field.invalid;
  return (
    <View
      {...(Platform.OS === "web" ? { dataSet: { fieldShell: "true" } } : {})}
      style={[
        {
          flexDirection: "row", alignItems: "center", gap: space.x2,
          minHeight: control.height.md, borderRadius: radius.md, paddingHorizontal: space.x4,
          backgroundColor: color.surface,
          borderWidth: 1,
          borderColor: invalid ? color.risk : focused ? color.focus : color.controlBorder,
        },
        focused && Platform.OS === "web" ? ({ boxShadow: `0 0 0 3px ${color.focus}` } as any) : null,
      ]}
    >
      {left}
      <TextInput
        ref={ref}
        placeholderTextColor={color.inkSoft}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        style={[
          {
            flex: 1, minWidth: 0, fontFamily: font.regular, fontSize: 16, color: color.ink,
            paddingVertical: space.x3, minHeight: control.height.md,
          },
          Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : null,
          style,
        ]}
        {...rest}
        accessibilityLabel={rest.accessibilityLabel || field.label || rest.placeholder}
        aria-invalid={invalid || undefined}
        aria-describedby={field.description}
      />
      {right}
    </View>
  );
});
