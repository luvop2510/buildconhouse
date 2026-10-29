import { Button as DesignButton } from "@/src/design/controls";
import { Overlay } from "@/src/design/Overlay";
import { NavigationTabs } from "@/src/design/NavigationTabs";
import { useReducedMotion } from "@/src/hooks/use-reduced-motion";
// BuildCon House · Shared mobile-first primitives
// Every screen composes UI from this file. No hardcoded colors, spacing, or
// typography outside the canonical design system.

import Feather from "@expo/vector-icons/Feather";
import { Children, cloneElement, isValidElement, useEffect, useRef, useId } from "react";
import { ActivityIndicator, Animated, Platform, Pressable, ScrollView, StyleSheet, TextInputProps, View, ViewStyle } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import {
  colors,
  elevation,
  icon as iconSize,
  layout,
  money,
  radius,
  spacing,
  type,
} from "@/src/theme/tokens";
import { color as ds, statusTone, toneColor } from "@/src/design/tokens";
// The single breakpoint authority. `layout` above comes from theme/tokens,
// which carries no `bp` — reading layout.bp there yields undefined and every
// comparison against it silently returns false.
import { useBp } from "@/src/design/responsive";

import { handleTableScrollKey, tableColumnLayout, tableMinWidth, type TableColumn } from "./tableLayout";
export { tableMinWidth } from "./tableLayout";

type FeatherName = keyof typeof Feather.glyphMap;

// ──────────────────────────────────────────────────────────────────────────
// Press-animated wrapper — subtle scale + opacity feedback for all touchables
// ──────────────────────────────────────────────────────────────────────────
// ──────────────────────────────────────────────────────────────────────────
// Button — primary / secondary / ghost / danger / brand-light
// ──────────────────────────────────────────────────────────────────────────
type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "brandLight" | "outline";
type ButtonSize = "sm" | "md" | "lg";
type ButtonProps = {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: FeatherName;
  iconRight?: FeatherName;
  loading?: boolean;
  disabled?: boolean;
  fullWidth?: boolean;
  testID?: string;
  style?: ViewStyle;
};

export function Button({ fullWidth, ...props }: ButtonProps) { return <DesignButton {...props} full={fullWidth} />; }

// ──────────────────────────────────────────────────────────────────────────
// IconButton — circular icon-only affordance
// ──────────────────────────────────────────────────────────────────────────
export function IconButton({
  icon, onPress, size = 44, tone = "surface", testID, accessibilityLabel, active, disabled, badge,
}: {
  icon: FeatherName;
  onPress?: () => void;
  size?: number;
  tone?: "surface" | "ghost" | "brand" | "brandLight" | "translucent" | "danger";
  testID?: string;
  accessibilityLabel?: string;
  active?: boolean;
  disabled?: boolean;
  badge?: number | string;
}) {
  const skin = {
    surface:     { bg: colors.surfaceSecondary, border: colors.border, fg: colors.onSurface },
    ghost:       { bg: "transparent",           border: "transparent", fg: colors.onSurface },
    brand:       { bg: colors.brand,            border: colors.brand,  fg: colors.onBrand },
    brandLight:  { bg: colors.brandTint,        border: colors.brandBorder, fg: colors.brand },
    translucent: { bg: "rgba(255,255,255,0.92)", border: colors.border, fg: colors.onSurface },
    danger:      { bg: colors.errorBg,          border: colors.errorBorder, fg: colors.error },
  }[tone];
  const buttonIconSize = iconSize.xl;

  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || icon.replace(/-/g, " ")}
      accessibilityState={{ disabled, selected: active }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={layout.hitSlop}
      style={({ pressed }) => [{
        width: Math.max(size, 44), height: Math.max(size, 44), borderRadius: radius.md,
        backgroundColor: skin.bg,
        borderWidth: tone === "ghost" ? 0 : StyleSheet.hairlineWidth,
        borderColor: skin.border,
        alignItems: "center", justifyContent: "center",
        opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
      }]}
    >
      <Feather accessible={false} name={icon} size={buttonIconSize} color={active ? colors.brand : skin.fg} />
      {badge !== undefined && badge !== 0 && badge !== "" ? (
        <View style={styles.iconBadge}>
          <Text style={styles.iconBadgeText}>{typeof badge === "number" && badge > 99 ? "99+" : String(badge)}</Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Card — elevated surface, single source of truth for cards.
// ──────────────────────────────────────────────────────────────────────────
export function Card({
  children, style, testID, variant = "flat", padding, onPress,
}: {
  children: React.ReactNode;
  style?: ViewStyle | ViewStyle[];
  testID?: string;
  variant?: "flat" | "elevated" | "outlined";
  padding?: number;
  onPress?: () => void;
}) {
  const { isPhone } = useBp();
  const skin = {
    flat:     { bg: colors.surfaceSecondary, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, shadow: null as any },
    elevated: { bg: colors.surfaceSecondary, borderWidth: 0,                        borderColor: "transparent",  shadow: elevation.low },
    outlined: { bg: "transparent",           borderWidth: 1,                        borderColor: colors.border,  shadow: null },
  }[variant];

  const content = (
    <View testID={testID} style={[
      {
        backgroundColor: skin.bg,
        borderRadius: radius.lg,
        borderWidth: skin.borderWidth,
        borderColor: skin.borderColor,
        padding: padding ?? (isPhone ? spacing.md : spacing.lg),
        minWidth: 0,
      },
      skin.shadow,
      style,
    ]}>
      {children}
    </View>
  );

  if (onPress) {
    return (
      <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => ({ opacity: pressed ? 0.92 : 1 })}>
        {content}
      </Pressable>
    );
  }
  return content;
}

// ──────────────────────────────────────────────────────────────────────────
// Badge / StatusBadge / Chip
// ──────────────────────────────────────────────────────────────────────────
export function Badge({
  label, tone = "neutral", size = "md", icon, testID, truncate = false,
}: {
  label: string;
  tone?: "neutral" | "brand" | "success" | "warning" | "error" | "info";
  size?: "sm" | "md";
  icon?: FeatherName;
  testID?: string;
  truncate?: boolean;
}) {
  const map = {
    neutral: { bg: colors.surfaceTertiary, fg: colors.onSurfaceSecondary, border: colors.border },
    brand:   { bg: colors.brandTint,       fg: colors.brand,              border: colors.brandBorder },
    success: { bg: colors.successBg,       fg: colors.success,            border: colors.successBorder },
    warning: { bg: colors.warningBg,       fg: colors.warning,            border: colors.warningBorder },
    error:   { bg: colors.errorBg,         fg: colors.error,              border: colors.errorBorder },
    info:    { bg: colors.infoBg,          fg: colors.info,               border: colors.infoBorder },
  }[tone];
  const padV = size === "sm" ? 2 : 4;
  const padH = size === "sm" ? 6 : 9;
  const fs = size === "sm" ? 10 : 11;

  return (
    <View testID={testID} style={{
      ...(truncate ? { maxWidth: "100%", minWidth: 0, flexShrink: 1 } as const : {}),
      backgroundColor: map.bg,
      paddingHorizontal: padH,
      paddingVertical: padV,
      borderRadius: radius.pill,
      alignSelf: "flex-start",
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: map.border,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    }}>
      {icon ? <Feather accessible={false} name={icon} size={fs + 1} color={map.fg} /> : null}
      <Text numberOfLines={truncate ? 1 : undefined} style={{ ...(truncate ? { minWidth: 0, flexShrink: 1 } : {}), color: map.fg, fontSize: fs, fontFamily: type.titleMd.fontFamily, fontWeight: "600", letterSpacing: 0.1 }}>
        {label}
      </Text>
    </View>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const meta = statusTone[status] || { label: status, tone: "neutral" as const };
  const t = toneColor[meta.tone];
  return (
    <View style={{
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: t.tint,
      paddingHorizontal: 10,
      paddingVertical: 4,
      borderRadius: radius.pill,
      alignSelf: "flex-start",
    }}>
      <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.dot }} />
      <Text style={{ color: t.fg, fontSize: 11, fontFamily: type.titleMd.fontFamily, fontWeight: "600", letterSpacing: 0.2 }}>
        {meta.label}
      </Text>
    </View>
  );
}

export function Chip({
  label, active, onPress, testID, icon, count,
}: {
  label: string; active?: boolean; onPress?: () => void; testID?: string;
  icon?: FeatherName; count?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={typeof count === "number" ? `${label}, ${count}` : label}
      aria-pressed={typeof active === "boolean" ? active : undefined}
      testID={testID}
      style={({ pressed }) => ({
        minHeight: 44,
        paddingVertical: 8,
        paddingHorizontal: spacing.lg,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: active ? ds.brassLine : colors.border,
        backgroundColor: active ? ds.brassTint : colors.surfaceSecondary,
        alignItems: "center",
        justifyContent: "center",
        flexDirection: "row",
        gap: 6,
        flexShrink: 0,
        opacity: pressed ? 0.85 : 1,
      })}
    >
      {icon ? <Feather accessible={false} name={icon} size={iconSize.md} color={active ? ds.brassDeep : colors.onSurfaceSecondary} /> : null}
      <Text style={{
        color: active ? ds.brassDeep : colors.onSurface,
        fontSize: 13,
        fontFamily: type.bodyStrong.fontFamily,
        fontWeight: active ? "600" : "500",
      }}>
        {label}
      </Text>
      {typeof count === "number" ? (
        <View style={{
          backgroundColor: active ? ds.sunkenDeep : colors.surfaceTertiary,
          paddingHorizontal: 6,
          paddingVertical: 1,
          borderRadius: radius.pill,
          marginLeft: 2,
        }}>
          <Text style={{
            color: active ? ds.brassDeep : colors.onSurfaceSecondary,
            fontSize: 11,
            fontFamily: type.titleMd.fontFamily,
            fontWeight: "600",
          }}>
            {count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Divider / Skeleton
// ──────────────────────────────────────────────────────────────────────────
export function Divider({ vertical, style, inset }: { vertical?: boolean; style?: ViewStyle; inset?: number }) {
  return (
    <View style={[
      vertical
        ? { width: StyleSheet.hairlineWidth, alignSelf: "stretch" }
        : { height: StyleSheet.hairlineWidth, alignSelf: "stretch", marginLeft: inset || 0 },
      { backgroundColor: colors.divider },
      style,
    ]} />
  );
}

export function Skeleton({ w = "100%", h = 14, style, radius: r }: { w?: number | string; h?: number; style?: ViewStyle; radius?: number }) {
  const reducedMotion = useReducedMotion();
  const pulse = useRef(new Animated.Value(0.5)).current;
  useEffect(() => {
    if (reducedMotion) { pulse.setValue(0.7); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: Platform.OS !== "web" }),
        Animated.timing(pulse, { toValue: 0.5, duration: 900, useNativeDriver: Platform.OS !== "web" }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse, reducedMotion]);

  return (
    <Animated.View style={[
      { width: w as any, height: h, backgroundColor: colors.surfaceTertiary, borderRadius: r ?? 8, opacity: pulse },
      style,
    ]} />
  );
}

// ──────────────────────────────────────────────────────────────────────────
// EmptyState / ErrorState / LoadingState
// ──────────────────────────────────────────────────────────────────────────
export function EmptyState({
  icon = "inbox", title, subtitle, action, tone = "neutral",
}: {
  icon?: FeatherName;
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  tone?: "neutral" | "brand";
}) {
  const chipBg = tone === "brand" ? colors.brandTint : colors.surfaceTertiary;
  const iconFg = tone === "brand" ? colors.brand : colors.onSurfaceMuted;
  return (
    <View style={{ alignItems: "center", padding: spacing.xxl, gap: spacing.md }}>
      <View style={{
        width: 64, height: 64, borderRadius: radius.pill,
        backgroundColor: chipBg,
        alignItems: "center", justifyContent: "center",
      }}>
        <Feather accessible={false} name={icon} size={26} color={iconFg} />
      </View>
      <Text style={[type.titleMd, { textAlign: "center" }]}>{title}</Text>
      {subtitle ? <Text style={[type.bodyMuted, { textAlign: "center", maxWidth: 320 }]}>{subtitle}</Text> : null}
      {action ? <View style={{ marginTop: 4 }}>{action}</View> : null}
    </View>
  );
}

export function ErrorState({
  title = "Something went wrong", subtitle, onRetry,
}: {
  title?: string; subtitle?: string; onRetry?: () => void;
}) {
  return (
    <EmptyState
      icon="alert-triangle"
      title={title}
      subtitle={subtitle}
      action={onRetry ? <Button label="Try again" icon="refresh-cw" variant="secondary" onPress={onRetry} /> : undefined}
    />
  );
}

export function LoadingState({ label }: { label?: string }) {
  return (
    <View style={{ alignItems: "center", padding: spacing.xxl, gap: spacing.md }}>
      <ActivityIndicator size="small" color={colors.brand} />
      {label ? <Text style={type.bodyMuted}>{label}</Text> : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SectionHeader / ScreenTitle
// ──────────────────────────────────────────────────────────────────────────
export function SectionHeader({
  title, subtitle, right, tone = "default",
}: {
  title: string; subtitle?: string; right?: React.ReactNode;
  tone?: "default" | "compact";
}) {
  const { isPhone } = useBp();
  const titleStyle = tone === "compact" ? type.titleMd : type.titleLg;
  return (
    <View style={{ flexDirection: isPhone ? "column" : "row", justifyContent: "space-between", alignItems: isPhone ? "stretch" : "flex-end", marginBottom: spacing.md, gap: spacing.md }}>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={titleStyle} numberOfLines={2}>{title}</Text>
        {subtitle ? <Text style={[type.bodyMuted, { marginTop: 2 }]} numberOfLines={2}>{subtitle}</Text> : null}
      </View>
      {right ? <View style={isPhone ? { alignSelf: "stretch" } : undefined}>{right}</View> : null}
    </View>
  );
}

export function ScreenTitle({
  title, subtitle, right, back,
}: {
  title: string; subtitle?: string | null; right?: React.ReactNode; back?: () => void;
}) {
  const { isPhone } = useBp();
  return (
    <View style={{
      flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.md,
      paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.md,
      backgroundColor: colors.surface,
    }}>
      {back ? <IconButton icon="chevron-left" onPress={back} size={44} tone="surface" accessibilityLabel="Back" /> : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text numberOfLines={2} style={type.displayMd}>{title}</Text>
        {subtitle ? <Text numberOfLines={2} style={[type.bodyMuted, { marginTop: 2 }]}>{subtitle}</Text> : null}
      </View>
      {right ? <View style={isPhone ? { width: "100%", alignItems: "flex-start" } : undefined}>{right}</View> : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SegmentedControl — iOS-native feel
// ──────────────────────────────────────────────────────────────────────────
export function SegmentedControl<T extends string>(props: {
  value: T; options: { value: T; label: string; icon?: FeatherName }[];
  onChange: (value: T) => void; size?: "sm" | "md"; testID?: string; fullWidth?: boolean;
}) { return <NavigationTabs {...props} segmented />; }

// ──────────────────────────────────────────────────────────────────────────
// Tabs — underline scrolling nav (like Linear / Notion)
// ──────────────────────────────────────────────────────────────────────────
export function Tabs<T extends string>(props: {
  value: T; options: { value: T; label: string; count?: number }[];
  onChange: (value: T) => void; testID?: string;
}) { return <NavigationTabs {...props} />; }

// ──────────────────────────────────────────────────────────────────────────
// TextField — unified input for the whole app
// ──────────────────────────────────────────────────────────────────────────
export function TextField({
  label, error, helper, leftIcon, rightIcon, onRightPress, containerStyle, ...rest
}: TextInputProps & {
  label?: string;
  error?: string | null;
  helper?: string;
  leftIcon?: FeatherName;
  rightIcon?: FeatherName;
  onRightPress?: () => void;
  containerStyle?: ViewStyle;
}) {
  const descriptionId = useId();
  const showError = !!error;
  return (
    <View style={[{ gap: spacing.sm }, containerStyle]}>
      {label ? <Text style={type.label}>{label}</Text> : null}
      <View {...(Platform.OS === "web" ? { dataSet: { fieldShell: "true" } } : {})} style={{
        flexDirection: "row", alignItems: "center",
        backgroundColor: colors.surfaceSecondary,
        borderWidth: 1,
        borderColor: showError ? colors.error : colors.border,
        borderRadius: radius.md,
        paddingHorizontal: spacing.lg,
        minHeight: 48,
      }}>
        {leftIcon ? <Feather accessible={false} name={leftIcon} size={16} color={colors.onSurfaceMuted} style={{ marginRight: 8 }} /> : null}
        <TextInput
          {...rest}
          accessibilityLabel={rest.accessibilityLabel || label || rest.placeholder}
          accessibilityHint={rest.accessibilityHint || (showError ? error || undefined : helper)}
          aria-invalid={showError || undefined}
          aria-describedby={helper || error ? descriptionId : undefined}
          placeholderTextColor={rest.placeholderTextColor || colors.onSurfaceMuted}
          style={[{
            flex: 1,
            paddingVertical: spacing.md,
            fontSize: 16,
            minWidth: 0,
            fontFamily: type.body.fontFamily,
            color: colors.onSurface,
          }, rest.style]}
        />
        {rightIcon ? (
          <Pressable accessibilityRole="button" accessibilityLabel={rightIcon?.startsWith("eye") ? "Toggle password visibility" : rightIcon?.replace(/-/g, " ")} onPress={onRightPress} hitSlop={layout.hitSlop} style={{ marginLeft: 8, minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
            <Feather accessible={false} name={rightIcon} size={16} color={colors.onSurfaceMuted} />
          </Pressable>
        ) : null}
      </View>
      {helper && !showError ? <Text nativeID={descriptionId} style={type.caption}>{helper}</Text> : null}
      {showError ? <Text nativeID={descriptionId} accessibilityRole="alert" accessibilityLiveRegion="polite" style={[type.caption, { color: colors.error }]}>{error}</Text> : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SearchField — compact search input
// ──────────────────────────────────────────────────────────────────────────
export function SearchField({ onClear, ...props }: TextInputProps & { onClear?: () => void }) {
  const hasValue = typeof props.value === "string" && props.value.length > 0;
  return (
    <View {...(Platform.OS === "web" ? { dataSet: { fieldShell: "true" } } : {})} style={{
      flexDirection: "row", alignItems: "center",
      backgroundColor: colors.surfaceTertiary,
        borderRadius: radius.md,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        paddingHorizontal: 12,
        minHeight: 44,
    }}>
      <Feather accessible={false} name="search" size={15} color={colors.onSurfaceMuted} style={{ marginRight: 8 }} />
      <TextInput
        {...props}
        accessibilityLabel={props.accessibilityLabel || props.placeholder || "Search"}
        placeholderTextColor={colors.onSurfaceMuted}
        style={[{
          flex: 1, minWidth: 0, fontSize: 16, fontFamily: type.body.fontFamily,
          color: colors.onSurface, paddingVertical: 0,
        }, props.style]}
      />
      {hasValue && onClear ? (
        <Pressable accessibilityRole="button" accessibilityLabel="Clear search" onPress={onClear} hitSlop={layout.hitSlop} style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
          <Feather accessible={false} name="x" size={14} color={colors.onSurfaceMuted} />
        </Pressable>
      ) : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// KPI card — dashboard number tile
// ──────────────────────────────────────────────────────────────────────────
export function KpiCard({
  label, value, sub, icon, tone = "neutral", trend, onPress, style, question, footer, testID,
}: {
  label: string;
  value: string;
  sub?: string;
  icon?: FeatherName;
  tone?: "neutral" | "brand" | "success" | "warning";
  trend?: { value: string; direction: "up" | "down" };
  onPress?: () => void;
  style?: ViewStyle;
  /** The owner question this card answers. It ships on the card, in small
   *  type under the value — spec 7 is explicit that this is not documentation.
   *  Optional so every existing call site is unaffected. */
  question?: string;
  /** Comparison line, sparkline, or any honest substitute for a delta. */
  footer?: React.ReactNode;
  testID?: string;
}) {
  const toneMap = {
    neutral: { bg: colors.surfaceSecondary, iconBg: colors.surfaceTertiary, iconFg: colors.onSurfaceMuted },
    brand:   { bg: colors.surfaceSecondary, iconBg: colors.brandTint,      iconFg: colors.brand },
    success: { bg: colors.surfaceSecondary, iconBg: colors.successBg,     iconFg: colors.success },
    warning: { bg: colors.surfaceSecondary, iconBg: colors.warningBg,     iconFg: colors.warning },
  }[tone];

  // A KPI row is read by scanning down a column of values, so the value's
  // optical size and the card's height must not vary with how much optional
  // chrome a given card happens to carry. Both are driven by the breakpoint
  // alone: every card in a row is the same height whether or not it has an
  // icon, a trend, a footer or a question.
  const { isPhone } = useBp();

  const cardPadding = isPhone ? layout.cardPadding.base : layout.cardPadding.spacious;
  const valueSize = isPhone ? 24 : 28;
  // Tall enough that the label / value / question stack breathes at every
  // width, and identical across the row so the cards form a single band
  // rather than a ragged skyline.
  const minHeight = isPhone ? 124 : 148;

  const Container: any = onPress ? Pressable : View;
  return (
    <Container
      testID={testID}
      onPress={onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? `${label}: ${value}` : undefined}
      style={[{
        backgroundColor: toneMap.bg,
        borderRadius: radius.lg,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        padding: cardPadding,
        gap: spacing.s8,
        minHeight,
        justifyContent: "flex-start",
      }, style]}
    >
      <View style={{
        flexDirection: "row",
        justifyContent: "space-between",
        alignItems: "center",
        gap: spacing.s8,
        minHeight: 20,
      }}>
        {/* overline, not captionStrong: uppercase + tracked reads as a field
            label rather than as body copy, which is what lets the value below
            carry the whole visual weight of the card. */}
        <Text style={[type.overline, { flexShrink: 1 }]} numberOfLines={1}>{label}</Text>
        {icon ? (
          <View style={{
            width: 36, height: 36, borderRadius: radius.md,
            backgroundColor: toneMap.iconBg,
            alignItems: "center", justifyContent: "center",
          }}>
            <Feather accessible={false} name={icon} size={iconSize.md} color={toneMap.iconFg} />
          </View>
        ) : null}
      </View>

      {/* adjustsFontSizeToFit is a no-op on react-native-web, so the value is
          sized by breakpoint instead of relying on it to rescue an overflow. */}
      <Text
        style={{
          fontSize: valueSize,
          lineHeight: Math.round(valueSize * 1.2),
          fontFamily: type.displayMd.fontFamily,
          fontWeight: "700",
          color: colors.onSurface,
          letterSpacing: -0.6,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {value}
      </Text>

      {sub || trend ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.s8, flexWrap: "wrap" }}>
          {trend ? (
            <View style={{
              flexDirection: "row", alignItems: "center", gap: spacing.s4,
              backgroundColor: trend.direction === "up" ? colors.successBg : colors.errorBg,
              paddingHorizontal: spacing.s8, paddingVertical: 3, borderRadius: radius.sm,
            }}>
              <Feather
                name={trend.direction === "up" ? "trending-up" : "trending-down"}
                size={iconSize.sm}
                color={trend.direction === "up" ? colors.success : colors.error}
              />
              <Text style={{
                fontSize: 11,
                fontFamily: type.titleMd.fontFamily,
                fontWeight: "600",
                color: trend.direction === "up" ? colors.success : colors.error,
              }}>
                {trend.value}
              </Text>
            </View>
          ) : null}
          {sub ? <Text style={type.caption}>{sub}</Text> : null}
        </View>
      ) : null}

      {footer}

      {/* Pinned to the bottom edge so the question line sits on one baseline
          across the whole row, however tall the value stack above it is. */}
      {question ? (
        <Text
          style={[type.caption, { color: colors.onSurfaceMuted, marginTop: "auto", paddingTop: spacing.s8 }]}
          numberOfLines={2}
        >
          {question}
        </Text>
      ) : null}
    </Container>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ListRow — unified tappable row for lists (customers, quotations, payments)
// ──────────────────────────────────────────────────────────────────────────
export function ListRow({
  title, subtitle, meta, metaSecondary, right, leading, onPress, testID, isFirst, isLast,
}: {
  title: string;
  subtitle?: string;
  meta?: string;
  metaSecondary?: string;
  right?: React.ReactNode;
  leading?: React.ReactNode;
  onPress?: () => void;
  testID?: string;
  isFirst?: boolean;
  isLast?: boolean;
}) {
  const { isPhone } = useBp();
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        paddingHorizontal: spacing.lg,
        paddingVertical: 14,
        backgroundColor: pressed ? colors.surfaceTertiary : "transparent",
        borderTopWidth: isFirst ? 0 : StyleSheet.hairlineWidth,
        borderColor: colors.divider,
      })}
    >
      {leading}
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text numberOfLines={isPhone ? 2 : 1} style={{
          fontSize: 15,
          fontFamily: type.titleMd.fontFamily,
          fontWeight: "600",
          color: colors.onSurface,
          letterSpacing: -0.1,
        }}>{title}</Text>
        {subtitle ? <Text numberOfLines={isPhone ? 2 : 1} style={type.caption}>{subtitle}</Text> : null}
      </View>
      <View style={{ alignItems: "flex-end", gap: 4, flexShrink: 0, maxWidth: isPhone ? "42%" : undefined }}>
        {meta ? <Text style={{
          fontSize: 14,
          fontFamily: type.titleMd.fontFamily,
          fontWeight: "600",
          color: colors.onSurface,
          fontVariant: ["tabular-nums"],
        }}>{meta}</Text> : null}
        {metaSecondary ? <Text style={type.caption}>{metaSecondary}</Text> : null}
        {right}
      </View>
    </Pressable>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Avatar — initials-based
// ──────────────────────────────────────────────────────────────────────────
export function Avatar({
  name, size = 36, tone = "brand",
}: {
  name?: string; size?: number; tone?: "brand" | "surface" | "neutral";
}) {
  const initials = (name || "?")
    .split(" ")
    .map((s) => s[0])
    .filter(Boolean)
    .slice(0, 2)
    .join("")
    .toUpperCase();

  const skin = {
    brand:   { bg: colors.brand,           fg: colors.onBrand },
    surface: { bg: colors.surfaceTertiary, fg: colors.onSurfaceSecondary },
    neutral: { bg: colors.surfaceInverse,  fg: colors.onSurfaceInverse },
  }[tone];

  return (
    <View style={{
      width: size, height: size, borderRadius: size / 2,
      backgroundColor: skin.bg,
      alignItems: "center", justifyContent: "center",
    }}>
      <Text style={{
        color: skin.fg,
        fontSize: size * 0.36,
        fontFamily: type.titleMd.fontFamily,
        fontWeight: "600",
        letterSpacing: 0.2,
      }}>
        {initials}
      </Text>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// PriceTag — consistent price rendering (with optional strike-through MRP)
// ──────────────────────────────────────────────────────────────────────────
export function PriceTag({
  price, mrp, size = "md", align = "left",
}: {
  price: number;
  mrp?: number;
  size?: "sm" | "md" | "lg" | "xl";
  align?: "left" | "right";
}) {
  const showSlash = typeof mrp === "number" && mrp > price;
  const priceSize = size === "xl" ? 26 : size === "lg" ? 20 : size === "sm" ? 13 : 16;
  const mrpSize   = size === "xl" ? 14 : size === "lg" ? 13 : size === "sm" ? 11 : 12;
  return (
    <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, justifyContent: align === "right" ? "flex-end" : "flex-start", flexShrink: 1, minWidth: 0 }}>
      <Text
        numberOfLines={1}
        ellipsizeMode="clip"
        style={{
          fontSize: priceSize,
          fontFamily: type.titleMd.fontFamily,
          fontWeight: "700",
          color: colors.onSurface,
          fontVariant: ["tabular-nums"],
          letterSpacing: -0.2,
          flexShrink: 1,
        }}
      >{money(price)}</Text>
      {showSlash ? (
        <Text
          numberOfLines={1}
          ellipsizeMode="clip"
          style={{
            fontSize: mrpSize,
            color: colors.onSurfaceMuted,
            textDecorationLine: "line-through",
            fontVariant: ["tabular-nums"],
            fontFamily: type.body.fontFamily,
            flexShrink: 0,
          }}
        >{money(mrp!)}</Text>
      ) : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// BrandMark — the little BC logo tile
// ──────────────────────────────────────────────────────────────────────────
export function BrandMark({ size = 32, inverse }: { size?: number; inverse?: boolean }) {
  return (
    <View style={{
      width: size, height: size, borderRadius: Math.max(8, size * 0.28),
      backgroundColor: inverse ? "rgba(255,255,255,0.14)" : colors.brand,
      borderWidth: inverse ? 1 : 0,
      borderColor: inverse ? "rgba(255,255,255,0.24)" : "transparent",
      alignItems: "center", justifyContent: "center",
    }}>
      <Feather accessible={false} name="home" size={size * 0.48} color={inverse ? colors.onSurfaceInverse : colors.onBrand} />
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Alerts — inline info/success/warning/error surfaces
// ──────────────────────────────────────────────────────────────────────────
export function Alert({
  tone, title, description, icon, action,
}: {
  tone: "info" | "success" | "warning" | "error";
  title: string;
  description?: string;
  icon?: FeatherName;
  action?: React.ReactNode;
}) {
  const map = {
    info:    { bg: colors.infoBg,    fg: colors.info,    border: colors.infoBorder,    icon: (icon || "info") as FeatherName },
    success: { bg: colors.successBg, fg: colors.success, border: colors.successBorder, icon: (icon || "check-circle") as FeatherName },
    warning: { bg: colors.warningBg, fg: colors.warning, border: colors.warningBorder, icon: (icon || "alert-triangle") as FeatherName },
    error:   { bg: colors.errorBg,   fg: colors.error,   border: colors.errorBorder,   icon: (icon || "x-circle") as FeatherName },
  }[tone];

  return (
    <View role={tone === "error" || tone === "warning" ? "alert" : "status"} aria-live={tone === "error" ? "assertive" : "polite"} style={{
      backgroundColor: map.bg,
      borderColor: map.border,
      borderWidth: 1,
      borderRadius: radius.md,
      padding: spacing.md,
      flexDirection: "row",
      gap: spacing.md,
      alignItems: "flex-start",
    }}>
      <Feather accessible={false} name={map.icon} size={16} color={map.fg} style={{ marginTop: 2 }} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ fontSize: 13, fontFamily: type.titleMd.fontFamily, fontWeight: "600", color: map.fg }}>{title}</Text>
        {description ? <Text style={{ fontSize: 13, fontFamily: type.body.fontFamily, color: map.fg, opacity: 0.9, lineHeight: 18 }}>{description}</Text> : null}
      </View>
      {action}
    </View>
  );
}

// Style-sheet for internal use
const styles = StyleSheet.create({
  iconBadge: {
    position: "absolute",
    top: -2, right: -2,
    minWidth: 16, height: 16, paddingHorizontal: 4,
    borderRadius: radius.pill,
    backgroundColor: colors.error,
    alignItems: "center", justifyContent: "center",
    borderWidth: 1.5, borderColor: colors.surfaceSecondary,
  },
  iconBadgeText: {
    color: colors.onBrand,
    fontSize: 9,
    fontFamily: type.titleMd.fontFamily,
    fontWeight: "700",
  },
});

// Legacy helper
export const s = { spacing, colors, radius, type } as const;

// ══════════════════════════════════════════════════════════════════════════
// DESIGN SYSTEM · Phase 3 additions — Sheet, Modal, PageHeader, HeroBanner,
// StatTile, DataTable, richer Skeletons, HoverCard, FormField, Toolbar.
// All primitives below consume only tokens; no hardcoded hex, spacing, or
// typography. Every dialog and drawer shares identical chrome.
// ══════════════════════════════════════════════════════════════════════════

// ──────────────────────────────────────────────────────────────────────────
// Icon — one canonical way to render an icon anywhere in the app.
// ──────────────────────────────────────────────────────────────────────────
export function Icon({
  name, size = "md", color, style,
}: {
  name: FeatherName;
  size?: keyof typeof iconSize;
  color?: string;
  style?: any;
}) {
  return <Feather accessible={false} name={name} size={iconSize[size]} color={color || colors.onSurface} style={style} />;
}

// ──────────────────────────────────────────────────────────────────────────
// Sheet — the ONE dialog/drawer primitive.
//   variant:
//     drawer  → right-anchored 460px panel on desktop, bottom-sheet on phone (default)
//     modal   → center dialog on all breakpoints (max 520px)
//     bottom  → always bottom sheet
// Chrome (header + body scroll area + footer) identical for every screen.
// ──────────────────────────────────────────────────────────────────────────
type SheetVariant = "drawer" | "modal" | "bottom";
export function Sheet({ visible, variant = "drawer", scroll = false, ...props }: Omit<React.ComponentProps<typeof Overlay>, "open" | "presentation"> & {
  visible: boolean; variant?: SheetVariant;
}) { return <Overlay {...props} open={visible} scroll={scroll} presentation={variant === "modal" ? "dialog" : variant} />; }

// ──────────────────────────────────────────────────────────────────────────
// PageHeader — every screen top. Always identical chrome.
// Optional back button, title, subtitle, action cluster (right).
// ──────────────────────────────────────────────────────────────────────────
export { PageHeader } from "@/src/design/PageHeader";

// ──────────────────────────────────────────────────────────────────────────
// HeroBanner — the "brand card" hero used on Payments, Purchases, Followups.
// Soft blue-tinted background, overline, title, subtitle, optional action cluster.
// ──────────────────────────────────────────────────────────────────────────
export function HeroBanner({
  overline, title, subtitle, actions, tone = "brand", icon: iconName,
}: {
  overline?: string;
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  tone?: "brand" | "neutral";
  icon?: FeatherName;
}) {
  const { isPhone } = useBp();
  const bg = tone === "brand" ? colors.brandTint : colors.surfaceTertiary;
  const border = tone === "brand" ? colors.brandBorder : colors.border;
  return (
    <View style={{
      padding: spacing.xl,
      borderRadius: radius.lg,
      backgroundColor: bg,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: border,
      flexDirection: isPhone ? "column" : "row",
      gap: spacing.lg,
      alignItems: "flex-start",
    }}>
      {iconName ? (
        <View style={{
          width: 48, height: 48, borderRadius: radius.md,
          backgroundColor: colors.surfaceSecondary,
          alignItems: "center", justifyContent: "center",
          ...elevation.hairline,
        }}>
          <Feather accessible={false} name={iconName} size={iconSize.xl} color={colors.brand} />
        </View>
      ) : null}
      <View style={{ flex: 1, minWidth: 0 }}>
        {overline ? <Text style={[type.overline, { marginBottom: 6 }]}>{overline}</Text> : null}
        <Text style={type.displayMd} numberOfLines={2}>{title}</Text>
        {subtitle ? <Text style={[type.bodyMuted, { marginTop: 6, maxWidth: 640 }]}>{subtitle}</Text> : null}
      </View>
      {actions ? (
        <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center", flexShrink: 0, flexWrap: "wrap", width: isPhone ? "100%" : undefined }}>{actions}</View>
      ) : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// StatTile — dashboard/hero stat card with icon, label, big number, delta.
// Auto-scales the value at narrow widths. Every tile identical across the app.
// ──────────────────────────────────────────────────────────────────────────
export function StatTile({
  label, value, sub, icon, tone = "neutral", onPress, style, dense,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon?: FeatherName;
  tone?: "neutral" | "brand" | "success" | "warning" | "danger";
  onPress?: () => void;
  style?: ViewStyle;
  dense?: boolean;
}) {
  const map = {
    neutral: { iconBg: colors.surfaceTertiary, iconFg: colors.onSurfaceSecondary, valueFg: colors.onSurface },
    brand:   { iconBg: colors.brandTint,       iconFg: colors.brand,              valueFg: colors.onSurface },
    success: { iconBg: colors.successBg,       iconFg: colors.success,            valueFg: colors.success },
    warning: { iconBg: colors.warningBg,       iconFg: colors.warning,            valueFg: colors.warning },
    danger:  { iconBg: colors.errorBg,         iconFg: colors.error,              valueFg: colors.error },
  }[tone];

  const Container: any = onPress ? Pressable : View;
  return (
    <Container
      onPress={onPress}
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={onPress ? `${label}: ${value}` : undefined}
      style={[{
        flex: 1,
        minWidth: 150,
        padding: dense ? spacing.md : spacing.lg,
        borderRadius: radius.lg,
        backgroundColor: colors.surfaceSecondary,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        gap: dense ? 8 : spacing.md,
      }, elevation.hairline as any, style]}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
        <Text
          style={[type.overline, { flex: 1 }]}
          numberOfLines={2}
          ellipsizeMode="tail"
        >
          {label}
        </Text>
        {icon ? (
          <View style={{
            width: dense ? 28 : 32, height: dense ? 28 : 32, borderRadius: radius.sm,
            backgroundColor: map.iconBg,
            alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <Feather accessible={false} name={icon} size={dense ? iconSize.sm : iconSize.md} color={map.iconFg} />
          </View>
        ) : null}
      </View>
      <Text
        style={{
          fontSize: dense ? 20 : 24,
          fontFamily: type.displayMd.fontFamily,
          fontWeight: "700",
          color: map.valueFg,
          letterSpacing: -0.4,
          fontVariant: ["tabular-nums"],
        }}
        numberOfLines={1}
        adjustsFontSizeToFit
        minimumFontScale={0.55}
      >
        {String(value)}
      </Text>
      {sub ? <Text style={type.caption} numberOfLines={1}>{sub}</Text> : null}
    </Container>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// DataTable — Table / TableHeader / TableRow / TableCell primitives.
// Every table in the app shares row height, header height, hover, and typography.
// ──────────────────────────────────────────────────────────────────────────
export function Table({ children, style, accessibilityLabel = "Data table", testID }: {
  children: React.ReactNode; style?: ViewStyle; accessibilityLabel?: string; testID?: string;
}) {
  const header = Children.toArray(children).find(child => isValidElement(child) && child.type === TableHeader);
  const columns = isValidElement<{ columns: TableColumn[] }>(header) ? header.props.columns : [];
  const minimumWidth = tableMinWidth(columns, spacing.md, layout.table.cellPaddingX) + StyleSheet.hairlineWidth * 2;
  return (
    <ScrollView horizontal testID={testID} accessibilityLabel={`${accessibilityLabel}. Scroll horizontally for more columns.`}
      {...(Platform.OS === "web" ? { onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => handleTableScrollKey(event) } : {})}
      tabIndex={Platform.OS === "web" ? 0 : undefined} showsHorizontalScrollIndicator
      keyboardShouldPersistTaps="handled" style={{ minWidth: 0, maxWidth: "100%" }}
      contentContainerStyle={{ flexGrow: 1 }}>
      <View role="table" accessibilityLabel={accessibilityLabel} style={[{
        flexGrow: 1, minWidth: minimumWidth, backgroundColor: colors.surfaceSecondary,
        borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md,
      }, style]}>{children}</View>
    </ScrollView>
  );
}

export function TableHeader({ columns }: { columns: TableColumn[] }) {
  return (
    <View role="row" style={{
      flexDirection: "row",
      minHeight: layout.table.headerHeight,
      alignItems: "center",
      paddingHorizontal: layout.table.cellPaddingX,
      backgroundColor: colors.surfaceSubtle,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      gap: spacing.md,
    }}>
      {columns.map((c, i) => (
        <Text
          key={i}
          role="columnheader"
          style={[
            type.overline,
            {
              ...tableColumnLayout(c),
              paddingVertical: spacing.sm,
              ...(Platform.OS === "web" ? { overflowWrap: "anywhere" } as any : {}),
              textAlign: c.align || "left",
            },
          ]}
        >
          {c.label}
        </Text>
      ))}
    </View>
  );
}

export function TableRow({
  children, onPress, isLast, testID, active,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  isLast?: boolean;
  testID?: string;
  active?: boolean;
}) {
  return (
    <Pressable
      testID={testID}
      role="row"
      tabIndex={onPress ? 0 : undefined}
      {...(Platform.OS === "web" && onPress ? { onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onPress(); } } } : {})}
      onPress={onPress}
      style={({ pressed, hovered }: any) => [{
        flexDirection: "row",
        minHeight: layout.table.rowHeight,
        alignItems: "center",
        paddingHorizontal: layout.table.cellPaddingX,
        borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: colors.divider,
        backgroundColor:
          active ? colors.brandTint
          : pressed ? colors.surfaceTertiary
          : hovered ? colors.surfaceSubtle
          : "transparent",
        gap: spacing.md,
      }]}
    >
      {children}
    </Pressable>
  );
}

export function TableCell({
  children, flex, width, align = "left", testID,
}: {
  children: React.ReactNode;
  flex?: number;
  width?: number;
  align?: "left" | "right" | "center";
  testID?: string;
}) {
  return (
    <View
      testID={testID}
      role="cell"
      style={{
        ...tableColumnLayout({ width, flex }),
        maxWidth: width !== undefined ? width : "100%",
        paddingVertical: spacing.sm,
        flexDirection: align === "right" ? "row-reverse" : "row",
        justifyContent: align === "center" ? "center" : "flex-start",
        alignItems: "center",
        gap: spacing.sm,
      }}
    >
      <View style={{ width: "100%", minWidth: 0, maxWidth: "100%", flexShrink: 1 }}>
        {isValidElement(children) || (Array.isArray(children) && children.some(child => isValidElement(child)))
          ? Children.map(children, child => {
            if (!isValidElement<{ style?: any }>(child)) return child;
            const original = child.props.style;
            const bounds = { minWidth: 0, maxWidth: "100%", flexShrink: 1, ...(Platform.OS === "web" ? { overflowWrap: "anywhere" } : {}) };
            return cloneElement(child, { style: typeof original === "function"
              ? (state: unknown) => [original(state), bounds]
              : [original, bounds, child.type === Text ? { textAlign: align } : null] });
          })
          : <Text style={[type.bodySm, { minWidth: 0, maxWidth: "100%", flexShrink: 1, textAlign: align }, Platform.OS === "web" ? { overflowWrap: "anywhere" } as any : null]}>{children}</Text>}
      </View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Skeleton library — SkeletonRow, SkeletonCard, SkeletonGrid, SkeletonList.
// Consistent shimmer for every loading state.
// ──────────────────────────────────────────────────────────────────────────
export function SkeletonRow({ height = 14, widths }: { height?: number; widths?: (number | string)[] }) {
  const cols = widths || ["40%", "20%", "20%", "12%"];
  return (
    <View style={{ flexDirection: "row", gap: spacing.md, alignItems: "center", minHeight: layout.table.rowHeight, paddingHorizontal: layout.table.cellPaddingX }}>
      {cols.map((w, i) => (
        <Skeleton key={i} w={w as any} h={height} radius={radius.sm} style={{ flex: typeof w === "string" && w.endsWith("%") ? 0 : 1 }} />
      ))}
    </View>
  );
}

export function SkeletonCard({ height = 120 }: { height?: number }) {
  return (
    <View style={{
      padding: spacing.lg,
      borderRadius: radius.lg,
      backgroundColor: colors.surfaceSecondary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      gap: spacing.md,
      minHeight: height,
    }}>
      <Skeleton w="60%" h={12} radius={radius.sm} />
      <Skeleton w="40%" h={22} radius={radius.sm} />
      <Skeleton w="80%" h={12} radius={radius.sm} />
    </View>
  );
}

export function SkeletonList({ rows = 5 }: { rows?: number }) {
  return (
    <View style={{
      backgroundColor: colors.surfaceSecondary,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: "hidden",
    }}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={{
          borderBottomWidth: i === rows - 1 ? 0 : StyleSheet.hairlineWidth,
          borderBottomColor: colors.divider,
        }}>
          <SkeletonRow />
        </View>
      ))}
    </View>
  );
}

export function SkeletonGrid({ columns = 3, cards = 6 }: { columns?: number; cards?: number }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
      {Array.from({ length: cards }).map((_, i) => (
        <View key={i} style={{ flexBasis: `${100 / columns - 1}%`, flexGrow: 1, minWidth: 200 }}>
          <SkeletonCard height={160} />
        </View>
      ))}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// FormField — label + helper + child input. Consistent form spacing everywhere.
// ──────────────────────────────────────────────────────────────────────────
export function FormField({
  label, helper, error, required, children, testID,
}: {
  label?: string;
  helper?: string;
  error?: string | null;
  required?: boolean;
  children: React.ReactNode;
  testID?: string;
}) {
  return (
    <View testID={testID} style={{ gap: 6 }}>
      {label ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
          <Text style={type.label}>{label}</Text>
          {required ? <Text style={{ color: colors.error, fontSize: 12, fontWeight: "600" }}>*</Text> : null}
        </View>
      ) : null}
      {children}
      {error ? <Text style={[type.caption, { color: colors.error }]}>{error}</Text>
      : helper ? <Text style={type.caption}>{helper}</Text>
      : null}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Toolbar — consistent sub-header row (used above lists, tables, grids).
// Layout: left cluster · flex spacer · right cluster.
// ──────────────────────────────────────────────────────────────────────────
export function Toolbar({
  left, right, style,
}: {
  left?: React.ReactNode;
  right?: React.ReactNode;
  style?: ViewStyle;
}) {
  return (
    <View style={[{
      flexDirection: "row",
      alignItems: "center",
      gap: spacing.md,
      paddingVertical: spacing.md,
    }, style]}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flex: 1, flexWrap: "wrap" }}>{left}</View>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>{right}</View>
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// SegmentedTabs — variant of Tabs that includes counts in a pill.
// (Kept in ui.tsx so screens can pick either underline or pill navigation.)
// ──────────────────────────────────────────────────────────────────────────
export function PillTabs<T extends string>({
  value, options, onChange, testID,
}: {
  value: T;
  options: { value: T; label: string; count?: number; icon?: FeatherName }[];
  onChange: (v: T) => void;
  testID?: string;
}) {
  return (
    // width: "100%" is load-bearing, not decorative: without an explicit
    // width, RN-Web sizes this row to its content (shrink-to-fit) instead of
    // its parent's available width, so flexWrap never triggers — pills past
    // the viewport edge are silently clipped by an ancestor's overflow, not
    // wrapped onto a second line. Fits by luck with 4 short options; breaks
    // silently the moment a caller passes enough options or long enough
    // labels to overflow (found via a 6-option preset picker at 375px).
    <View testID={testID} style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap", width: "100%" }}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <Pressable
            key={String(o.value)}
            testID={testID ? `${testID}-${o.value}` : undefined}
            onPress={() => onChange(o.value)}
            style={({ pressed }) => ({
              paddingHorizontal: spacing.md,
              height: 34,
              borderRadius: radius.pill,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: on ? colors.brand : colors.border,
              backgroundColor: on ? colors.brandTint : colors.surfaceSecondary,
              flexDirection: "row",
              alignItems: "center",
              gap: 6,
              opacity: pressed ? 0.85 : 1,
            })}
          >
            {o.icon ? <Feather accessible={false} name={o.icon} size={iconSize.sm} color={on ? colors.brand : colors.onSurfaceMuted} /> : null}
            <Text style={{
              fontSize: 13,
              fontFamily: type.titleMd.fontFamily,
              fontWeight: on ? "600" : "500",
              color: on ? colors.brand : colors.onSurface,
            }}>
              {o.label}
            </Text>
            {typeof o.count === "number" ? (
              <View style={{
                minWidth: 20,
                paddingHorizontal: 6,
                height: 18,
                borderRadius: radius.pill,
                backgroundColor: on ? colors.brand : colors.surfaceTertiary,
                alignItems: "center", justifyContent: "center",
              }}>
                <Text style={{
                  fontSize: 10,
                  fontFamily: type.titleMd.fontFamily,
                  fontWeight: "700",
                  color: on ? colors.onBrand : colors.onSurfaceMuted,
                }}>{o.count}</Text>
              </View>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// ProgressBar — thin, tone-coded progress line for order collection %.
// ──────────────────────────────────────────────────────────────────────────
export function ProgressBar({
  percent, tone = "brand", size = "sm",
}: {
  percent: number;
  tone?: "brand" | "success" | "warning" | "danger" | "neutral";
  size?: "xs" | "sm" | "md";
}) {
  const height = size === "xs" ? 3 : size === "sm" ? 4 : 8;
  const fill =
    tone === "success" ? colors.success
    : tone === "warning" ? colors.warning
    : tone === "danger" ? colors.error
    : tone === "neutral" ? colors.onSurfaceMuted
    : colors.brand;
  const pct = Math.max(0, Math.min(100, percent));
  return (
    <View style={{
      height,
      borderRadius: radius.pill,
      backgroundColor: colors.surfaceTertiary,
      overflow: "hidden",
    }}>
      <View style={{
        height: "100%",
        width: `${pct}%`,
        backgroundColor: fill,
        borderRadius: radius.pill,
      }} />
    </View>
  );
}
