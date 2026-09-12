import React, { createContext, useContext, useState, useId } from 'react';
import { Text, TextInput, View, Platform } from 'react-native';
import { color, font, radius } from './tokens';
import { Txt } from './typography';

const FieldLabelContext = createContext<{ label?: string; description?: string; invalid?: boolean }>({});
export function Field({
  label, error, helper, children,
}: { label?: string; error?: string | null; helper?: string; children: React.ReactNode }) {
  const description = useId();
  return (
    <View style={{ gap: 7 }}>
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
      style={[
        {
          flexDirection: "row", alignItems: "center", gap: 10,
          height: 44, borderRadius: radius.md, paddingHorizontal: 14,
          backgroundColor: color.surface,
          borderWidth: 1,
          borderColor: invalid ? color.risk : focused ? color.brass : color.line,
        },
        focused && Platform.OS === "web" ? ({ boxShadow: `0 0 0 3px ${color.focus}` } as any) : null,
      ]}
    >
      {left}
      <TextInput
        ref={ref}
        placeholderTextColor={color.inkFaint}
        onFocus={(e) => { setFocused(true); onFocus?.(e); }}
        onBlur={(e) => { setFocused(false); onBlur?.(e); }}
        style={[
          {
            flex: 1, minWidth: 0, fontFamily: font.regular, fontSize: 16, color: color.ink,
            paddingVertical: 0, height: "100%",
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
