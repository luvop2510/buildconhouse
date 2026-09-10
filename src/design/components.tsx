import { useReducedMotion } from "@/src/hooks/use-reduced-motion";
// ─────────────────────────────────────────────────────────────────────────────
// BuildCon House · Showroom primitives.
// Every screen composes ONLY these. No local styling in modules.
// ─────────────────────────────────────────────────────────────────────────────
import { Feather } from "@expo/vector-icons";
import React, {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from "react";
import {
  ActivityIndicator, Animated, Easing, KeyboardAvoidingView, Modal, Platform,
  Pressable, ScrollView, StyleProp, StyleSheet, Text, TextInput, TextStyle,
  useWindowDimensions, View, ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  color, fmtMoney, fmtMoneyCompact, font, layout, motion, radius, shadow, space,
  statusTone, text, Tone, toneColor,
} from "./tokens";
import { useBp } from "./responsive";

export type FeatherName = keyof typeof Feather.glyphMap;
const webCursor = Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null;

// ═════════════════════════════════════════════ Typography ═══════════════════
type TxtVariant = keyof typeof text;
export function Txt({
  v = "body", tone, style, numberOfLines, children, selectable,
}: {
  v?: TxtVariant;
  tone?: "ink" | "mid" | "soft" | "faint" | "ok" | "warn" | "risk" | "brass" | "onAction";
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  selectable?: boolean;
  children: React.ReactNode;
}) {
  const toneColorMap = {
    ink: color.ink, mid: color.inkMid, soft: color.inkSoft, faint: color.inkFaint,
    ok: color.ok, warn: color.warn, risk: color.risk, brass: color.brassDeep,
    onAction: color.onAction,
  } as const;
  return (
    <Text
      numberOfLines={numberOfLines}
      selectable={selectable}
      style={[text[v] as TextStyle, tone ? { color: toneColorMap[tone] } : null, style]}
    >
      {children}
    </Text>
  );
}

// ═════════════════════════════════════════════ Money ════════════════════════
// ₹ rendered smaller & softer than the digits — the amount is the message.
export function Money({
  value, size = "md", compact, tone, style,
}: {
  value: number;
  size?: "xl" | "lg" | "md" | "sm";
  compact?: boolean;
  tone?: "ink" | "mid" | "soft" | "ok" | "risk";
  style?: StyleProp<TextStyle>;
}) {
  const base =
    size === "xl" ? text.moneyXl : size === "lg" ? text.moneyLg :
    size === "sm" ? text.moneySm : text.money;
  const symbolSize = size === "xl" ? 19 : size === "lg" ? 15 : size === "sm" ? 11 : 12;
  const fg =
    tone === "mid" ? color.inkMid : tone === "soft" ? color.inkSoft :
    tone === "ok" ? color.ok : tone === "risk" ? color.risk : color.ink;
  return (
    <Text style={[base as TextStyle, { color: fg }, style]}>
      <Text style={{ fontSize: symbolSize, color: tone ? fg : color.inkSoft, fontFamily: font.regular }}>₹</Text>
      {compact ? fmtMoneyCompact(value) : fmtMoney(value)}
    </Text>
  );
}

// ═════════════════════════════════════════════ Hairline ═════════════════════
export function Hairline({ style, vertical }: { style?: StyleProp<ViewStyle>; vertical?: boolean }) {
  return (
    <View
      style={[
        vertical
          ? { width: layout.hairline, alignSelf: "stretch", backgroundColor: color.line }
          : { height: layout.hairline, alignSelf: "stretch", backgroundColor: color.line },
        style,
      ]}
    />
  );
}

// ═════════════════════════════════════════════ Button ═══════════════════════
export function Button({
  label, onPress, variant = "primary", size = "md", icon, loading, disabled, full, testID,
}: {
  label: string;
  onPress?: () => void;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  icon?: FeatherName;
  loading?: boolean;
  disabled?: boolean;
  full?: boolean;
  testID?: string;
}) {
  // Phase 4 · Batch 1 (Production UI Consistency & UX Audit): sizing values
  // below are intentionally identical to src/components/ui.tsx's Button —
  // previously this system used h=34/40/48 vs ui.tsx's 34/44/52, so a "md"
  // button rendered a different height depending only on which screen it
  // was on. Every button in the app now shares one height/padding/icon-size
  // per size name, regardless of which component file renders it.
  const h = size === "sm" ? 44 : size === "lg" ? 52 : 44;
  const px = size === "sm" ? 12 : size === "lg" ? 20 : 16;
  const fs = size === "sm" ? 13 : size === "lg" ? 15 : 14;
  const iconPx = size === "sm" ? 14 : size === "lg" ? 18 : 16;
  const btnRadius = size === "sm" ? 8 : 12;
  const dim = disabled || loading;

  const face = (pressed: boolean, hovered: boolean): ViewStyle => {
    switch (variant) {
      case "primary":
        return { backgroundColor: pressed || hovered ? color.actionHover : color.action };
      case "secondary":
        return {
          backgroundColor: pressed ? color.sunken : hovered ? color.canvas : color.surface,
          borderWidth: 1, borderColor: hovered ? color.lineStrong : color.line,
        };
      case "danger":
        return { backgroundColor: pressed || hovered ? "#983F33" : color.risk };
      default: // ghost
        return { backgroundColor: pressed ? color.pressWash : hovered ? color.hoverWash : "transparent" };
    }
  };
  const fg = variant === "primary" || variant === "danger" ? color.onAction
    : variant === "ghost" ? color.inkMid : color.ink;

  return (
    <Pressable
      testID={testID}
      onPress={dim ? undefined : onPress}
      disabled={dim}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: dim }}
      style={({ pressed, hovered }: any) => [
        {
          height: h, paddingHorizontal: px, borderRadius: btnRadius,
          flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8,
          opacity: dim ? 0.45 : 1,
          alignSelf: full ? "stretch" : "auto",
          transform: [{ scale: pressed ? 0.98 : 1 }],
        },
        face(!!pressed, !!hovered),
        webCursor,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={fg} />
      ) : icon ? (
        <Feather name={icon} size={iconPx} color={fg} />
      ) : null}
      <Text style={{ fontFamily: font.semibold, fontWeight: "600", fontSize: fs, color: fg, letterSpacing: -0.1 }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function IconButton({
  icon, onPress, size = 34, iconSize, tone = "mid", label, testID,
}: {
  icon: FeatherName;
  onPress?: () => void;
  size?: number;
  iconSize?: number;
  tone?: "ink" | "mid" | "soft" | "onAction" | "risk";
  label?: string;
  testID?: string;
}) {
  const fg = tone === "ink" ? color.ink : tone === "soft" ? color.inkSoft
    : tone === "onAction" ? color.onAction : tone === "risk" ? color.risk : color.inkMid;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      hitSlop={layout.hitSlop}
      style={({ pressed, hovered }: any) => [
        {
          width: Math.max(size, layout.tap), height: Math.max(size, layout.tap), borderRadius: radius.sm,
          alignItems: "center", justifyContent: "center",
          backgroundColor: pressed ? color.pressWash : hovered ? color.hoverWash : "transparent",
        },
        webCursor,
      ]}
    >
      <Feather name={icon} size={iconSize ?? Math.round(size * 0.5)} color={fg} />
    </Pressable>
  );
}

// ═════════════════════════════════════════════ Inputs ═══════════════════════
const FieldLabelContext = createContext<string | undefined>(undefined);
export function Field({
  label, error, helper, children,
}: { label?: string; error?: string | null; helper?: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 7 }}>
      {label ? <Txt v="caption" tone="mid">{label}</Txt> : null}
      <FieldLabelContext.Provider value={label}>{children}</FieldLabelContext.Provider>
      {error ? <Text accessibilityRole="alert" accessibilityLiveRegion="assertive" style={{ color: color.risk, fontFamily: font.regular, fontSize: 12 }}>{error}</Text>
        : helper ? <Txt v="caption" tone="soft">{helper}</Txt> : null}
    </View>
  );
}

export const Input = React.forwardRef<TextInput, React.ComponentProps<typeof TextInput> & {
  invalid?: boolean; right?: React.ReactNode; left?: React.ReactNode;
}>(function Input({ invalid, right, left, style, onFocus, onBlur, ...rest }, ref) {
  const [focused, setFocused] = useState(false);
  const fieldLabel = useContext(FieldLabelContext);
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
            flex: 1, fontFamily: font.regular, fontSize: 15, color: color.ink,
            paddingVertical: 0, height: "100%",
          },
          Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : null,
          style,
        ]}
        {...rest}
        accessibilityLabel={rest.accessibilityLabel || fieldLabel || rest.placeholder}
        aria-invalid={invalid || undefined}
      />
      {right}
    </View>
  );
});

// ═════════════════════════════════════════════ Status ═══════════════════════
export function StatusWord({ status, tone, label }: { status?: string; tone?: Tone; label?: string }) {
  const meta = status ? statusTone[status] : undefined;
  const t = tone ?? meta?.tone ?? "neutral";
  const l = label ?? meta?.label ?? status ?? "—";
  const c = toneColor[t];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: c.dot }} />
      <Text style={{ fontFamily: font.medium, fontWeight: "500", fontSize: 12.5, color: c.fg }}>{l}</Text>
    </View>
  );
}

// ═════════════════════════════════════════════ Avatar ═══════════════════════
export function Avatar({ name, size = 34 }: { name?: string | null; size?: number }) {
  const initials = (name || "?")
    .split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() ?? "").join("");
  return (
    <View
      style={{
        width: size, height: size, borderRadius: size / 2,
        backgroundColor: color.sunkenDeep, alignItems: "center", justifyContent: "center",
      }}
    >
      <Text style={{
        fontFamily: font.semibold, fontWeight: "600",
        fontSize: Math.round(size * 0.36), color: color.inkMid, letterSpacing: 0.3,
      }}>
        {initials}
      </Text>
    </View>
  );
}

// ═════════════════════════════════════════════ Surface / Section ════════════
export function Surface({
  children, pad = space.x5, style,
}: { children: React.ReactNode; pad?: number; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{
      backgroundColor: color.surface, borderRadius: radius.lg, padding: pad,
      borderWidth: layout.hairline, borderColor: color.line,
    }, style]}
    >
      {children}
    </View>
  );
}

export function Section({
  eyebrow, right, style,
}: { eyebrow: string; right?: React.ReactNode; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, style]}>
      <Txt v="eyebrow">{eyebrow}</Txt>
      {right}
    </View>
  );
}

// ═════════════════════════════════════════════ Row ══════════════════════════
export function Row({
  onPress, children, divider, pad = space.x4, minHeight = 56, testID, style,
}: {
  onPress?: () => void;
  children: React.ReactNode;
  divider?: boolean;
  pad?: number;
  minHeight?: number;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <>
      <Pressable
        testID={testID}
        onPress={onPress}
        disabled={!onPress}
        style={({ pressed, hovered }: any) => [
          {
            flexDirection: "row", alignItems: "center", gap: space.x3,
            paddingVertical: pad, minHeight,
            marginHorizontal: -space.x3, paddingHorizontal: space.x3, borderRadius: radius.md,
            backgroundColor: onPress && (pressed || hovered) ? color.hoverWash : "transparent",
          },
          onPress ? webCursor : null,
          style,
        ]}
      >
        {children}
      </Pressable>
      {divider ? <Hairline /> : null}
    </>
  );
}

// ═════════════════════════════════════════════ Empty / Skeleton ═════════════
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

// ═════════════════════════════════════════════ KeyCap ═══════════════════════
export function KeyCap({ label }: { label: string }) {
  return (
    <View style={{
      paddingHorizontal: 6, height: 20, borderRadius: 5,
      backgroundColor: color.surface, borderWidth: 1, borderColor: color.line,
      alignItems: "center", justifyContent: "center",
    }}>
      <Text style={{ fontFamily: font.medium, fontSize: 11, color: color.inkSoft }}>{label}</Text>
    </View>
  );
}

// ═════════════════════════════════════════════ Tabs ═════════════════════════
export function Tabs<T extends string>({
  items, value, onChange,
}: { items: { key: T; label: string; count?: number }[]; value: T; onChange: (k: T) => void }) {
  return (
    <View>
      <View style={{ flexDirection: "row", gap: space.x5 }}>
        {items.map((it) => {
          const on = it.key === value;
          return (
            <Pressable
              key={it.key}
              onPress={() => onChange(it.key)}
              style={({ hovered }: any) => [{ paddingVertical: 10 }, webCursor]}
            >
              <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
                <Text style={{
                  fontFamily: on ? font.semibold : font.medium,
                  fontWeight: on ? "600" : "500",
                  fontSize: 14, color: on ? color.ink : color.inkSoft, letterSpacing: -0.1,
                }}>
                  {it.label}
                </Text>
                {typeof it.count === "number" ? (
                  <Text style={{ fontFamily: font.medium, fontSize: 12, color: color.inkFaint, ...( { fontVariant: ["tabular-nums"] } as any) }}>
                    {it.count}
                  </Text>
                ) : null}
              </View>
              <View style={{
                height: 2, borderRadius: 1, marginTop: 8,
                backgroundColor: on ? color.ink : "transparent",
              }} />
            </Pressable>
          );
        })}
      </View>
      <Hairline style={{ marginTop: -1 }} />
    </View>
  );
}

// ═════════════════════════════════════════════ Sheet ════════════════════════
// One overlay primitive: bottom sheet on phones, centered panel on larger.
export function Sheet({
  open, onClose, title, children, footer, width = 480, maxHeight = 0.88, testID,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  width?: number;
  maxHeight?: number;
  testID?: string;
}) {
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { isPhone } = useBp();
  const anim = useRef(new Animated.Value(0)).current;
  const [visible, setVisible] = useState(open);

  useEffect(() => {
    if (open) {
      setVisible(true);
      Animated.timing(anim, { toValue: 1, duration: motion.standard, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start();
    } else {
      Animated.timing(anim, { toValue: 0, duration: motion.quick, easing: Easing.in(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start(({ finished }) => {
        if (finished) setVisible(false);
      });
    }
  }, [open, anim]);

  if (!visible) return null;

  const panel = (
    <Animated.View
      style={[
        {
          backgroundColor: color.surface,
          opacity: anim,
          ...shadow.overlay,
        },
        isPhone
          ? {
              borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl,
              paddingBottom: insets.bottom + space.x4,
              maxHeight: winH * maxHeight,
              transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }],
            }
          : {
              borderRadius: radius.xl, width: Math.min(width, winW - 48),
              maxHeight: winH * Math.min(maxHeight, 0.85), alignSelf: "center",
              transform: [
                { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [12, 0] }) },
                { scale: anim.interpolate({ inputRange: [0, 1], outputRange: [0.98, 1] }) },
              ],
            },
      ]}
    >
      {isPhone ? (
        <View style={{ alignItems: "center", paddingTop: 10 }}>
          <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: color.sunkenDeep }} />
        </View>
      ) : null}
      {title ? (
        <View style={{
          flexDirection: "row", alignItems: "center", justifyContent: "space-between",
          paddingHorizontal: space.x6, paddingTop: space.x5, paddingBottom: space.x3,
        }}>
          <Txt v="title">{title}</Txt>
          <IconButton icon="x" onPress={onClose} label="Close" />
        </View>
      ) : null}
      <ScrollView
        style={{ flexGrow: 0, flexShrink: 1 }}
        contentContainerStyle={{ paddingHorizontal: space.x6, paddingBottom: footer ? space.x3 : space.x6 + (isPhone ? insets.bottom : 0), paddingTop: title ? 0 : space.x6 }}
        keyboardShouldPersistTaps="handled"
      >
        {children}
      </ScrollView>
      {footer ? (
        <View style={{ paddingHorizontal: space.x6, paddingVertical: space.x4, borderTopWidth: layout.hairline, borderTopColor: color.line }}>
          {footer}
        </View>
      ) : null}
    </Animated.View>
  );

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim, opacity: anim }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel="Close sheet"
          />
        </Animated.View>
        <View
          style={{ flex: 1, justifyContent: isPhone ? "flex-end" : "center", pointerEvents: "box-none" }}
          accessibilityViewIsModal
          accessibilityLabel={title ? `${title} sheet` : "Dialog"}
          testID={testID}
        >
          {panel}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

// ═════════════════════════════════════════════ Dialog ═══════════════════════
export function Dialog({
  open, onClose, title, message, confirmLabel = "Confirm", cancelLabel = "Cancel",
  tone = "ink", onConfirm, busy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "ink" | "risk";
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <Sheet open={open} onClose={onClose} width={400}>
      <View style={{ gap: space.x2, paddingTop: space.x1 }}>
        <Txt v="title">{title}</Txt>
        {message ? <Txt v="bodyMid">{message}</Txt> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.x2, marginTop: space.x5 }}>
          <Button label={cancelLabel} variant="ghost" onPress={onClose} />
          <Button
            label={confirmLabel}
            variant={tone === "risk" ? "danger" : "primary"}
            onPress={onConfirm}
            loading={busy}
          />
        </View>
      </View>
    </Sheet>
  );
}

// ═════════════════════════════════════════════ Menu ═════════════════════════
export type MenuItem = { label: string; icon?: FeatherName; tone?: "ink" | "risk"; onPress: () => void };

export function Menu({
  items, children, align = "right", triggerLabel, triggerTestID,
}: { items: MenuItem[]; children: React.ReactNode; align?: "left" | "right"; triggerLabel?: string; triggerTestID?: string }) {
  const ref = useRef<View>(null);
  const [pos, setPos] = useState<{ x: number; y: number; w: number } | null>(null);
  const { width: winW, height: winH } = useWindowDimensions();
  const anim = useRef(new Animated.Value(0)).current;

  const openMenu = useCallback(() => {
    ref.current?.measureInWindow((x, y, w, h) => {
      setPos({ x, y: y + h + 6, w });
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: motion.quick, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start();
    });
  }, [anim]);

  const MENU_W = 216;
  const left = pos ? Math.max(12, Math.min(align === "right" ? pos.x + pos.w - MENU_W : pos.x, winW - MENU_W - 12)) : 0;
  const top = pos ? Math.min(pos.y, winH - items.length * 42 - 24) : 0;

  return (
    <>
      <Pressable
        ref={ref as any}
        testID={triggerTestID}
        accessibilityRole="button"
        accessibilityLabel={triggerLabel}
        onPress={openMenu}
        hitSlop={layout.hitSlop}
        style={webCursor as any}
      >
        {children}
      </Pressable>
      <Modal visible={!!pos} transparent animationType="none" onRequestClose={() => setPos(null)}>
        <Pressable style={StyleSheet.absoluteFill} onPress={() => setPos(null)} />
        {pos ? (
          <Animated.View
            style={[{
              position: "absolute", left, top, width: MENU_W,
              backgroundColor: color.surface, borderRadius: radius.lg,
              borderWidth: layout.hairline, borderColor: color.line,
              paddingVertical: 6, opacity: anim,
              transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }],
              ...shadow.overlay,
            }]}
          >
            {items.map((it, i) => (
              <Pressable
                key={i}
                onPress={() => { setPos(null); it.onPress(); }}
                style={({ pressed, hovered }: any) => [
                  {
                    flexDirection: "row", alignItems: "center", gap: 10,
                    paddingHorizontal: 14, height: 40,
                    backgroundColor: pressed || hovered ? color.hoverWash : "transparent",
                  },
                  webCursor,
                ]}
              >
                {it.icon ? (
                  <Feather name={it.icon} size={15} color={it.tone === "risk" ? color.risk : color.inkMid} />
                ) : null}
                <Text style={{
                  fontFamily: font.medium, fontWeight: "500", fontSize: 14,
                  color: it.tone === "risk" ? color.risk : color.ink,
                }}>
                  {it.label}
                </Text>
              </Pressable>
            ))}
          </Animated.View>
        ) : null}
      </Modal>
    </>
  );
}

// ═════════════════════════════════════════════ FadeIn ═══════════════════════
// Content settle — used once per screen on load. Communicates "ready".
export function FadeIn({ children, delay = 0, style }: {
  children: React.ReactNode; delay?: number; style?: StyleProp<ViewStyle>;
}) {
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(anim, {
      toValue: 1, duration: motion.entrance, delay,
      easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web",
    }).start();
  }, [anim, delay]);
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

// ═════════════════════════════════════════════ Palette context ══════════════
// The command palette host lives in the admin shell; screens call usePalette().
export const PaletteContext = createContext<{ open: () => void }>({ open: () => {} });
export const usePalette = () => useContext(PaletteContext);
