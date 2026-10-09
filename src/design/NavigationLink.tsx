import { Link, type Href } from "expo-router";
import React from "react";
import { Pressable, type View } from "react-native";

type PressableProps = React.ComponentProps<typeof Pressable>;

// Expo's child slot merges `style` as an object. Pass the Pressable style
// through a separate prop so callbacks and arrays retain their RN behavior.
const LinkTarget = React.forwardRef<View, PressableProps & { pressStyle?: PressableProps["style"] }>(
  function LinkTarget({ pressStyle, ...props }, ref) {
    return <Pressable {...props} ref={ref} style={pressStyle} />;
  },
);

export const NavigationLink = React.forwardRef<View, PressableProps & { href: Href }>(
  function NavigationLink({ href, style, ...props }, ref) {
    return <Link href={href} asChild><LinkTarget {...props} ref={ref} pressStyle={style} /></Link>;
  },
);
