// Shared interface font defaults preserve explicit tokens on web and native.
import { forwardRef, useEffect, useRef, type ElementRef } from "react";
import {
  Platform, StyleSheet, Text as NativeText, TextInput as NativeTextInput,
  type TextProps, type TextInputProps,
} from "react-native";
import { appTextFamily } from "./appTextFamily";
import { reportInputFocus } from "@/src/hooks/use-input-active";

// Preserve the instance types used by input refs and native focus/selection.
export type Text = ElementRef<typeof NativeText>;
export type TextInput = ElementRef<typeof NativeTextInput>;

// eslint-disable-next-line @typescript-eslint/no-redeclare -- component and instance type intentionally share the native export name
export const Text = forwardRef<Text, TextProps>(function AppText({ style, ...props }, ref) {
  return <NativeText {...props} ref={ref} style={[{ fontFamily: appTextFamily(StyleSheet.flatten(style)) }, style]} />;
});

// eslint-disable-next-line @typescript-eslint/no-redeclare -- preserve the TextInput instance type used by existing refs
export const TextInput = forwardRef<TextInput, TextInputProps>(function AppTextInput({ style, onFocus, onBlur, ...props }, ref) {
  const focusId = useRef(Symbol("input"));
  useEffect(() => {
    const id = focusId.current;
    return () => { if (Platform.OS !== "web") reportInputFocus(id, false); };
  }, []);
  return <NativeTextInput {...props} ref={ref}
    // Plain editing fields must not dismiss the keyboard and restore chrome on Enter.
    blurOnSubmit={props.blurOnSubmit ?? (props.submitBehavior || props.onSubmitEditing ? undefined : false)}
    onFocus={event => { if (Platform.OS !== "web") reportInputFocus(focusId.current, true); onFocus?.(event); }}
    onBlur={event => { if (Platform.OS !== "web") reportInputFocus(focusId.current, false); onBlur?.(event); }}
    style={[{ fontFamily: appTextFamily(StyleSheet.flatten(style)) }, style]} />;
});
