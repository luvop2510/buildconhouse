// Shared interface font defaults preserve explicit tokens on web and native.
import { forwardRef, type ElementRef } from "react";
import {
  StyleSheet, Text as NativeText, TextInput as NativeTextInput,
  type TextProps, type TextInputProps,
} from "react-native";
import { appTextFamily } from "./appTextFamily";

// Preserve the instance types used by input refs and native focus/selection.
export type Text = ElementRef<typeof NativeText>;
export type TextInput = ElementRef<typeof NativeTextInput>;

// eslint-disable-next-line @typescript-eslint/no-redeclare -- component and instance type intentionally share the native export name
export const Text = forwardRef<Text, TextProps>(function AppText({ style, ...props }, ref) {
  return <NativeText {...props} ref={ref} style={[{ fontFamily: appTextFamily(StyleSheet.flatten(style)) }, style]} />;
});

// eslint-disable-next-line @typescript-eslint/no-redeclare -- preserve the TextInput instance type used by existing refs
export const TextInput = forwardRef<TextInput, TextInputProps>(function AppTextInput({ style, ...props }, ref) {
  return <NativeTextInput {...props} ref={ref} style={[{ fontFamily: appTextFamily(StyleSheet.flatten(style)) }, style]} />;
});
