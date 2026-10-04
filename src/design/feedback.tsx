import React, { useEffect, useRef } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { Animated, Easing, Platform, View, type StyleProp, type ViewStyle } from 'react-native';
import { useReducedMotion } from '@/src/hooks/use-reduced-motion';
import { color, motion, space } from './tokens';
import { Txt } from './typography';
import type { FeatherName } from './shared';

export function EmptyState({
  icon = "wind", title, note, action,
}: { icon?: FeatherName; title: string; note?: string; action?: React.ReactNode }) {
  return (
    <View style={{ alignItems: "center", paddingVertical: space.x12, gap: space.x2 }}>
      <Feather name={icon} size={22} color={color.inkFaint} />
      <Txt v="rowTitle" tone="mid" style={{ marginTop: 6 }}>{title}</Txt>
      {note ? <Txt v="sub" tone="soft" style={{ textAlign: "center", maxWidth: 320 }}>{note}</Txt> : null}
      {action ? <View style={{ marginTop: space.x3 }}>{action}</View> : null}
    </View>
  );
}

export function Skeleton({ w = "100%", h = 14, r = 6, style }: {
  w?: number | `${number}%`; h?: number; r?: number; style?: StyleProp<ViewStyle>;
}) {
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (reducedMotion) { pulse.setValue(0.7); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== "web" }),
        Animated.timing(pulse, { toValue: 0.5, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: Platform.OS !== "web" }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reducedMotion]);
  return (
    <Animated.View
      style={[{ width: w, height: h, borderRadius: r, backgroundColor: color.sunkenDeep, opacity: pulse }, style]}
    />
  );
}
export function FadeIn({ children, delay = 0, style }: {
  children: React.ReactNode; delay?: number; style?: StyleProp<ViewStyle>;
}) {
  const reducedMotion = useReducedMotion();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reducedMotion) { anim.setValue(1); return; }
    Animated.timing(anim, {
      toValue: 1, duration: motion.entrance, delay,
      easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web",
    }).start();
  }, [anim, delay, reducedMotion]);
  return (
    <Animated.View style={[{
      opacity: anim,
      transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [6, 0] }) }],
    }, style]}
    >
      {children}
    </Animated.View>
  );
}
