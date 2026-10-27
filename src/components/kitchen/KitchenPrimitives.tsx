import { useCallback, useId, useLayoutEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { ActivityIndicator, Platform, Pressable, View, type ViewStyle } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { Text, TextInput } from "@/src/components/AppText";
import { Button, TextField } from "@/src/components/ui";
import { colors as appColors, type as appType } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";

/** Kitchen owns its visual language; other floor workspaces retain their theme. */
export const kitchenColors = {
  ...appColors,
  surface: "#F6F7F9", surfaceSecondary: "#FFFFFF", surfaceTertiary: "#EEF2F6",
  surfaceSubtle: "#F6F7F9", onSurface: "#17232E", onSurfaceSecondary: "#354454",
  onSurfaceMuted: "#53616F", onSurfaceSubtle: "#657483", border: "#D9E0E6",
  borderStrong: "#A7B5C2", controlBorder: "#7E8B98", divider: "#D9E0E6", brand: "#0066CC", brandHover: "#0053A6",
  brandTint: "#EDF5FF", brandBorder: "#B5D4F4", focusRing: "#0066CC",
} as const;
export const kitchenType = {
  ...appType,
  titleLg: { ...appType.titleLg, color: kitchenColors.onSurface, fontSize: 28, lineHeight: 36 },
  titleMd: { ...appType.titleMd, color: kitchenColors.onSurface, fontSize: 20, lineHeight: 28 },
  titleSm: { ...appType.titleSm, color: kitchenColors.onSurface, fontSize: 17, lineHeight: 24 },
  body: { ...appType.body, color: kitchenColors.onSurface, fontSize: 16, lineHeight: 24 },
  bodyStrong: { ...appType.bodyStrong, color: kitchenColors.onSurface, fontSize: 16, lineHeight: 24 },
  bodyMuted: { ...appType.bodyMuted, color: kitchenColors.onSurfaceMuted, fontSize: 16, lineHeight: 24 },
  bodySm: { ...appType.bodySm, color: kitchenColors.onSurface, fontSize: 14, lineHeight: 21 },
  caption: { ...appType.caption, color: kitchenColors.onSurfaceMuted, fontSize: 13, lineHeight: 19 },
  captionStrong: { ...appType.captionStrong, color: kitchenColors.onSurfaceSecondary, fontSize: 13, lineHeight: 19 },
  label: { ...appType.label, color: kitchenColors.onSurfaceSecondary, fontSize: 14, lineHeight: 20 },
  overline: { ...appType.overline, color: kitchenColors.onSurfaceMuted, fontSize: 12, lineHeight: 18, letterSpacing: 0.7 },
} as const;
export const kitchenTokens = { colors: kitchenColors, type: kitchenType, maxWidth: 1560, formWidth: 820, radius: 8, controlHeight: 48 } as const;

export function KitchenButton({ label, onPress, variant = "primary", size = "md", icon, iconRight, loading, disabled, fullWidth, testID, style }: ComponentProps<typeof Button>) {
  const [focused, setFocused] = useState(false);
  const unavailable = Boolean(disabled || loading);
  const primary = variant === "primary" || variant === "danger";
  const fg = primary ? "#FFFFFF" : variant === "outline" || variant === "brandLight" ? kitchenColors.brand : kitchenColors.onSurfaceSecondary;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: unavailable, busy: Boolean(loading) }} disabled={unavailable} onPress={onPress} onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} testID={testID} style={({ hovered, pressed }) => [{ minHeight: size === "lg" ? 52 : 44, minWidth: 44, maxWidth: "100%", alignSelf: fullWidth ? "stretch" : "flex-start", paddingVertical: 10, paddingHorizontal: size === "sm" ? 12 : 16, borderRadius: 8, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderWidth: 1, borderColor: focused ? kitchenColors.focusRing : primary ? "transparent" : variant === "ghost" ? "transparent" : kitchenColors.controlBorder, backgroundColor: variant === "danger" ? kitchenColors.error : variant === "primary" ? hovered || pressed ? kitchenColors.brandHover : kitchenColors.brand : variant === "brandLight" ? kitchenColors.brandTint : hovered || pressed ? kitchenColors.surfaceTertiary : variant === "ghost" ? "transparent" : kitchenColors.surfaceSecondary, opacity: unavailable ? 0.5 : 1, ...(Platform.OS === "web" ? { cursor: unavailable ? "default" : "pointer", outlineStyle: focused ? "solid" : "none", outlineWidth: 2, outlineOffset: 2, outlineColor: kitchenColors.focusRing } : {}) } as ViewStyle, style]}>{loading ? <ActivityIndicator color={fg} size="small" /> : icon ? <Feather accessible={false} name={icon} size={16} color={fg} /> : null}<Text style={{ ...kitchenType.bodyStrong, color: fg, fontSize: 14, lineHeight: 21, flexShrink: 1, textAlign: "center" }}>{label}</Text>{iconRight && !loading ? <Feather accessible={false} name={iconRight} size={16} color={fg} /> : null}</Pressable>;
}

export function KitchenTextField({ label, error, helper, containerStyle, style, onFocus, onBlur, onLayout, onContentSizeChange, leftIcon, rightIcon, onRightPress, ...props }: ComponentProps<typeof TextField>) {
  const id = useId();
  const [focused, setFocused] = useState(false);
  const [contentHeight, setContentHeight] = useState(46);
  const input = useRef<TextInput>(null);
  const resizeWeb = useCallback(() => {
    if (Platform.OS !== "web" || !props.multiline || !input.current) return;
    const textarea = input.current as unknown as HTMLTextAreaElement;
    // Reset before measuring so deleting text or widening the field also shrinks it.
    const scrollTop = textarea.scrollTop;
    textarea.style.height = "0px";
    const height = Math.max(46, textarea.scrollHeight);
    textarea.style.height = `${height}px`;
    textarea.scrollTop = scrollTop;
    setContentHeight(height);
  }, [props.multiline]);
  useLayoutEffect(resizeWeb, [resizeWeb, props.value, props.defaultValue]);
  return <View style={[{ gap: 8, minWidth: 0 }, containerStyle]}>
    {label ? <Text nativeID={`${id}-label`} style={kitchenType.label}>{label}</Text> : null}
    <View {...(Platform.OS === "web" ? { dataSet: { fieldShell: "true" } } : {})} style={{ minHeight: 48, flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, borderWidth: 1, borderColor: error ? kitchenColors.error : focused ? kitchenColors.focusRing : kitchenColors.controlBorder, borderRadius: 8, backgroundColor: props.editable === false ? kitchenColors.surface : kitchenColors.surfaceSecondary }}>
      {leftIcon ? <Feather accessible={false} name={leftIcon} size={18} color={kitchenColors.onSurfaceMuted} /> : null}
      <TextInput {...props} ref={input} numberOfLines={props.multiline ? 1 : props.numberOfLines} scrollEnabled={props.multiline ? true : props.scrollEnabled}
        accessibilityLabel={props.accessibilityLabel || label || props.placeholder} aria-labelledby={label ? `${id}-label` : undefined}
        aria-describedby={error || helper ? `${id}-description` : undefined} aria-invalid={Boolean(error)} accessibilityHint={props.accessibilityHint || error || helper}
        onFocus={event => { setFocused(true); onFocus?.(event); }} onBlur={event => { setFocused(false); onBlur?.(event); }}
        onLayout={event => { resizeWeb(); onLayout?.(event); }}
        onContentSizeChange={event => {
          if (Platform.OS !== "web" && props.multiline) setContentHeight(Math.max(46, Math.ceil(event.nativeEvent.contentSize.height)));
          onContentSizeChange?.(event);
        }}
        placeholderTextColor={kitchenColors.onSurfaceSubtle}
        style={[{ flex: 1, minWidth: 0, minHeight: 46, paddingVertical: props.multiline ? 11 : 12, ...kitchenType.body,
          textAlignVertical: props.multiline ? "top" : "center", ...(props.multiline ? { height: contentHeight, maxHeight: 320 } : {}),
          ...(Platform.OS === "web" ? { outlineStyle: "none", ...(props.multiline ? {
            // Grow short notes; long notes keep the browser's native caret scrolling above the keyboard.
            maxHeight: "max(46px, min(320px, calc(var(--forge-visible-height, 100dvh) - 190px)))", overflowY: "auto", overflowX: "hidden",
          } : {}) } : {}),
        } as any, style]} />
      {rightIcon ? <Pressable accessibilityRole="button" accessibilityLabel={rightIcon.replaceAll("-", " ")} onPress={onRightPress} style={{ minHeight: 44, minWidth: 44, justifyContent: "center", alignItems: "center" }}><Feather name={rightIcon} size={18} color={kitchenColors.onSurfaceSecondary} /></Pressable> : null}
    </View>
    {error || helper ? <Text nativeID={`${id}-description`} accessibilityRole={error ? "alert" : undefined} style={[kitchenType.caption, error ? { color: kitchenColors.error } : null]}>{error || helper}</Text> : null}
  </View>;
}

export function KitchenFieldRow({ children }: { children: ReactNode }) {
  const { isPhone } = useBp();
  return <View style={{ width: "100%", minWidth: 0, flexDirection: isPhone ? "column" : "row", flexWrap: "wrap", gap: isPhone ? 16 : 20 }}>{children}</View>;
}
