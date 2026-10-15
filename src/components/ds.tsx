import { Menu } from "@/src/design/navigationControls";
// ═══════════════════════════════════════════════════════════════════════════
// BuildCon House · Design System V2 · Primitives
// ═══════════════════════════════════════════════════════════════════════════
// Compatibility adapters. Canonical foundations live in src/design/.
// No page may create its own styles for these elements. Import everything from
// `@/src/components/ds` — nothing here allows hardcoded colors, spacing,
// typography, radius, elevation, or motion durations.
//
// Foundations (locked):
//   • Blue #2563EB  • Background #FAFBFC  • Cards pure white
//   • Border #E5E7EB  • Radius 12 (canonical card)  • Inter Variable
//   • Elevation: 4 subtle levels only  • Motion: press 80 / hover 120 /
//     modal 180 / drawer 220 / page 220 / cardHover scale 1.01
//
// Re-exports every existing primitive from `ui.tsx` so migrated screens only
// need to import from this one file.
// ═══════════════════════════════════════════════════════════════════════════
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, Platform, Pressable, ScrollView, StyleSheet, StyleProp, View, ViewStyle } from "react-native";
import { Text } from "@/src/components/AppText";

import {
  Button as _Button,
  Sheet as _Sheet,
} from "@/src/components/ui";
import {
  colors, elevation, icon as iconSize, motion,
  radius, spacing, statusMeta, type,
} from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";
import { useReducedMotion } from "@/src/hooks/use-reduced-motion";
import { filterValues, toggleFilterValue } from "@/src/utils/filters";
export { MobileFilterSection } from "@/src/components/MobileFilterSection";

// Re-export every existing primitive from ui.tsx.
// Screens should import from "@/src/components/ds" going forward.
export {
  Alert, Avatar, Badge, BrandMark, Button, Card, Chip, Divider, EmptyState,
  ErrorState, FormField, HeroBanner, Icon, IconButton, KpiCard, ListRow,
  LoadingState, PageHeader, PillTabs, PriceTag, ProgressBar,
  ScreenTitle, SearchField, SectionHeader, SegmentedControl, Sheet, Skeleton,
  SkeletonCard, SkeletonGrid, SkeletonList, SkeletonRow, StatTile, StatusBadge,
  Table, TableCell, TableHeader, TableRow, Tabs, TextField, Toolbar,
} from "@/src/components/ui";

type FeatherName = keyof typeof Feather.glyphMap;

// ───────────────────────────────────────────────────────────────────────────
// HoverCard — every card that needs hover feedback wraps children with this.
// Applies scale 1.01 + subtle elevation lift on web hover (per V2 spec).
// ───────────────────────────────────────────────────────────────────────────
export function HoverCard({
  onPress, children, style, disabled, testID, radius: r = radius.md,
  padding: p = spacing.lg,
}: {
  onPress?: () => void;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
  testID?: string;
  radius?: number;
  padding?: number;
}) {
  const cardStyle = ({ pressed = false, hovered = false } = {}) => [
    {
      backgroundColor: colors.surfaceSecondary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: hovered ? colors.borderStrong : colors.border,
      borderRadius: r,
      padding: p,
      opacity: pressed ? 0.94 : 1,
      ...(Platform.OS === "web" ? { transition: `border-color ${motion.hover.duration}ms ${motion.hover.easing}, background-color ${motion.hover.duration}ms ${motion.hover.easing}` } as any : {}),
    },
    elevation.low,
    style,
  ];
  if (!onPress) return <View testID={testID} style={cardStyle()}>{children}</View>;
  return <Pressable testID={testID} onPress={onPress} disabled={disabled} style={cardStyle}>{children}</Pressable>;
}

// ───────────────────────────────────────────────────────────────────────────
// HeroCard — the premium hero surface for module top-of-page.
// White card variant (matches spec) with optional icon tile, overline, big
// number/title, subtitle, and right-anchored action cluster.
// ───────────────────────────────────────────────────────────────────────────
export function HeroCard({
  overline, title, subtitle, icon, iconTone = "brand", actions, style,
  metaRow,
}: {
  overline?: string;
  title: string;
  subtitle?: string;
  icon?: FeatherName;
  iconTone?: "brand" | "success" | "warning" | "danger" | "neutral";
  actions?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  metaRow?: React.ReactNode;
}) {
  const { isPhone } = useBp();
  const iconMap = {
    brand:   { bg: colors.brandTint,       fg: colors.brand },
    success: { bg: colors.successBg,       fg: colors.success },
    warning: { bg: colors.warningBg,       fg: colors.warning },
    danger:  { bg: colors.errorBg,         fg: colors.error },
    neutral: { bg: colors.surfaceTertiary, fg: colors.onSurfaceSecondary },
  }[iconTone];

  return (
    <View style={[{
      padding: spacing.xl,
      borderRadius: radius.md,
      backgroundColor: colors.surfaceSecondary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      gap: spacing.md,
    }, elevation.low, style]}>
      <View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.lg, alignItems: "flex-start" }}>
        {icon ? (
          <View style={{
            width: 48, height: 48, borderRadius: radius.md,
            backgroundColor: iconMap.bg,
            alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}>
            <Feather name={icon} size={iconSize.xl} color={iconMap.fg} />
          </View>
        ) : null}
        <View style={{ flex: 1, minWidth: 0, gap: 6 }}>
          {overline ? <Text style={type.overline}>{overline}</Text> : null}
          <Text style={type.displayMd} numberOfLines={2}>{title}</Text>
          {subtitle ? <Text style={[type.bodyMuted, { maxWidth: 640 }]}>{subtitle}</Text> : null}
        </View>
        {actions ? (
          <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center", flexShrink: 0, flexWrap: "wrap", width: isPhone ? "100%" : undefined }}>
            {actions}
          </View>
        ) : null}
      </View>
      {metaRow}
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Panel — section container with optional title + right actions + subtle sep.
// Used to group related content on any page.
// ───────────────────────────────────────────────────────────────────────────
export function Panel({
  title, subtitle, actions, children, style, padding: p = spacing.xl,
  testID, overline,
}: {
  title?: string;
  subtitle?: string;
  overline?: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  padding?: number;
  testID?: string;
}) {
  const { isPhone } = useBp();
  return (
    <View testID={testID} style={[{
      borderRadius: radius.md,
      backgroundColor: colors.surfaceSecondary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: "hidden",
    }, elevation.low, style]}>
      {(title || actions) ? (
        <View style={{
          flexDirection: isPhone ? "column" : "row",
          alignItems: isPhone ? "stretch" : "center",
          justifyContent: "space-between",
          paddingHorizontal: p,
          paddingTop: p,
          paddingBottom: subtitle ? 4 : spacing.md,
          gap: spacing.md,
        }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            {overline ? <Text style={[type.overline, { marginBottom: 4 }]}>{overline}</Text> : null}
            {title ? <Text style={type.titleLg} numberOfLines={1}>{title}</Text> : null}
            {subtitle ? <Text style={[type.bodySm, { color: colors.onSurfaceMuted, marginTop: 2 }]} numberOfLines={2}>{subtitle}</Text> : null}
          </View>
          {actions ? (
            <View style={{ flexDirection: "row", gap: spacing.sm, alignItems: "center", flexWrap: "wrap" }}>{actions}</View>
          ) : null}
        </View>
      ) : null}
      <View style={{ padding: p, paddingTop: (title || actions) ? spacing.md : p }}>
        {children}
      </View>
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// FilterBar — label + horizontal Chip row. Used on every list page.
// ───────────────────────────────────────────────────────────────────────────
export function FilterBar<T extends string>({
  value, options, onChange, label, testID, multiSelect = false,
}: {
  value: T;
  options: { value: T; label: string; count?: number; icon?: FeatherName }[];
  onChange: (v: T) => void;
  label?: string;
  testID?: string;
  multiSelect?: boolean;
}) {
  const { isPhone } = useBp();
  return (
    <View style={{ gap: spacing.sm }}>
      {label ? <Text style={type.overline}>{label}</Text> : null}
      <ScrollView
        horizontal
        // Filter choices may legitimately extend beyond a phone width. Keep
        // the native indicator visible so that clipped chips read as a
        // scrollable control, not missing options.
        showsHorizontalScrollIndicator
        contentContainerStyle={{ gap: spacing.sm, paddingRight: spacing.lg }}
      >
        {options.map((o) => {
          const on = multiSelect ? (o.value === "all" ? !filterValues(value).length : filterValues(value).includes(o.value)) : o.value === value;
          return (
            <Pressable
              key={String(o.value)}
              testID={testID ? `${testID}-${o.value}` : undefined}
              accessibilityRole={multiSelect ? "checkbox" : "button"}
              accessibilityState={multiSelect ? { checked: on } : { selected: on }}
              aria-checked={multiSelect ? on : undefined}
              aria-pressed={multiSelect ? undefined : on}
              onPress={() => onChange((multiSelect ? toggleFilterValue(value, o.value) : o.value) as T)}
              style={({ pressed, hovered }: any) => ({
                paddingHorizontal: spacing.md,
                minHeight: isPhone ? 44 : 34,
                borderRadius: radius.pill,
                borderWidth: StyleSheet.hairlineWidth,
                borderColor: on ? colors.brand : hovered ? colors.borderStrong : colors.border,
                backgroundColor: on ? colors.brandTint : colors.surfaceSecondary,
                flexDirection: "row",
                alignItems: "center",
                gap: 6,
                opacity: pressed ? 0.85 : 1,
                ...(Platform.OS === "web" ? ({ transition: `border-color ${motion.hover.duration}ms ${motion.hover.easing}` } as any) : {}),
              })}
            >
              {o.icon ? <Feather name={o.icon} size={iconSize.sm} color={on ? colors.brand : colors.onSurfaceMuted} /> : null}
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
                  minWidth: 20, paddingHorizontal: 6, height: 18,
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
      </ScrollView>
    </View>
  );
}

export function MultiSelectFilterBar({ values, options, onChange, label, testID }: {
  values: string[];
  options: { value: string; label: string; count?: number; icon?: FeatherName }[];
  onChange: (values: string[]) => void;
  label?: string;
  testID?: string;
}) {
  return <FilterBar multiSelect value={values.join(",") || "all"} options={options} label={label} testID={testID} onChange={value => onChange(filterValues(value))} />;
}

// ───────────────────────────────────────────────────────────────────────────
// BrandCard — square-ish brand tile for the Catalogue brand grid.
// ───────────────────────────────────────────────────────────────────────────
export function BrandCard({
  name, logoUri, productCount, active, onPress, style, testID,
}: {
  name: string;
  logoUri?: string | null;
  productCount?: number;
  active?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}) {
  const initials = name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();
  return (
    <HoverCard
      onPress={onPress}
      testID={testID}
      style={[{
        alignItems: "center",
        justifyContent: "center",
        paddingVertical: spacing.lg,
        gap: spacing.sm,
        minHeight: 116,
        borderColor: active ? colors.brand : colors.border,
        backgroundColor: active ? colors.brandTint : colors.surfaceSecondary,
      }, style]}
    >
      <View style={{
        width: 56, height: 56, borderRadius: radius.md,
        overflow: "hidden",
        backgroundColor: colors.surfaceTertiary,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: colors.border,
        alignItems: "center", justifyContent: "center",
      }}>
        {logoUri ? (
          <Image source={{ uri: logoUri }} style={{ width: 48, height: 48, resizeMode: "contain" }} />
        ) : (
          <Text style={{
            fontSize: 18,
            fontFamily: type.titleLg.fontFamily,
            fontWeight: "700",
            color: colors.onSurfaceSecondary,
            letterSpacing: -0.4,
          }}>{initials}</Text>
        )}
      </View>
      <Text style={[type.titleSm, { textAlign: "center" }]} numberOfLines={1}>{name}</Text>
      {typeof productCount === "number" ? (
        <Text style={type.caption} numberOfLines={1}>{productCount} products</Text>
      ) : null}
    </HoverCard>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ProductCard — Catalogue product tile. Image on top, price + brand chip below.
// ───────────────────────────────────────────────────────────────────────────
export function ProductCard({
  name, sku, brandName, price, mrp, imageUri, onPress, favourite, onToggleFavourite,
  badge, style, testID, dense,
}: {
  name: string;
  sku?: string | null;
  brandName?: string | null;
  price: number;
  mrp?: number | null;
  imageUri?: string | null;
  onPress?: () => void;
  favourite?: boolean;
  onToggleFavourite?: () => void;
  badge?: { label: string; tone: "brand" | "success" | "warning" | "danger" };
  style?: StyleProp<ViewStyle>;
  testID?: string;
  dense?: boolean;
}) {
  const discount = mrp && mrp > price ? Math.round(((mrp - price) / mrp) * 100) : 0;
  const badgeTone = badge ? {
    brand:   { bg: colors.brandTint, fg: colors.brand },
    success: { bg: colors.successBg, fg: colors.success },
    warning: { bg: colors.warningBg, fg: colors.warning },
    danger:  { bg: colors.errorBg,   fg: colors.error },
  }[badge.tone] : null;

  return (
    <HoverCard
      onPress={onPress}
      testID={testID}
      padding={0}
      style={[{ overflow: "hidden" }, style]}
    >
      <View style={{
        aspectRatio: dense ? 1.4 : 1,
        backgroundColor: colors.surfaceTertiary,
        alignItems: "center", justifyContent: "center",
        position: "relative",
      }}>
        {imageUri ? (
          <Image source={{ uri: imageUri }} style={{ width: "100%", height: "100%", resizeMode: "cover" }} />
        ) : (
          <Feather name="image" size={iconSize.hero} color={colors.onSurfaceSubtle} />
        )}
        {badge && badgeTone ? (
          <View style={{
            position: "absolute", top: spacing.md, left: spacing.md,
            paddingHorizontal: spacing.sm, height: 22,
            borderRadius: radius.sm,
            backgroundColor: badgeTone.bg,
            justifyContent: "center",
          }}>
            <Text style={{
              fontSize: 11, fontFamily: type.titleMd.fontFamily,
              fontWeight: "700", color: badgeTone.fg,
            }}>{badge.label.toUpperCase()}</Text>
          </View>
        ) : null}
        {onToggleFavourite ? (
          <Pressable
            onPress={onToggleFavourite}
            style={({ pressed }) => ({
              position: "absolute", top: spacing.md, right: spacing.md,
              width: 32, height: 32, borderRadius: radius.pill,
              backgroundColor: colors.surfaceSecondary,
              alignItems: "center", justifyContent: "center",
              opacity: pressed ? 0.85 : 1,
              borderWidth: StyleSheet.hairlineWidth,
              borderColor: colors.border,
            })}
          >
            <Feather name="heart" size={iconSize.md} color={favourite ? colors.error : colors.onSurfaceMuted} />
          </Pressable>
        ) : null}
      </View>
      <View style={{ padding: spacing.md, gap: 4 }}>
        {brandName ? <Text style={type.overline} numberOfLines={1}>{brandName}</Text> : null}
        <Text style={type.titleSm} numberOfLines={2}>{name}</Text>
        {sku ? <Text style={[type.caption, { fontFamily: type.mono.fontFamily }]} numberOfLines={1}>{sku}</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: spacing.sm, marginTop: 4, flexWrap: "wrap" }}>
          <Text style={{
            fontSize: 16, fontFamily: type.titleMd.fontFamily,
            fontWeight: "700", color: colors.onSurface,
            fontVariant: ["tabular-nums"],
          }}>₹{price.toLocaleString("en-IN")}</Text>
          {mrp && mrp > price ? (
            <>
              <Text style={{
                fontSize: 12, color: colors.onSurfaceMuted,
                textDecorationLine: "line-through",
                fontVariant: ["tabular-nums"],
              }}>₹{mrp.toLocaleString("en-IN")}</Text>
              <Text style={{
                fontSize: 11, fontFamily: type.titleMd.fontFamily,
                fontWeight: "700", color: colors.success,
              }}>{discount}% OFF</Text>
            </>
          ) : null}
        </View>
      </View>
    </HoverCard>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// QuotationCard — list item for the Quotations index.
// ───────────────────────────────────────────────────────────────────────────
export function QuotationCard({
  number, customerName, projectName, itemCount, roomCount, grandTotal, status,
  updatedAt, onPress, testID, revisionCount,
}: {
  number: string;
  customerName: string;
  projectName?: string | null;
  itemCount: number;
  roomCount?: number | null;
  grandTotal: number;
  status: string;
  updatedAt?: string | null;
  onPress?: () => void;
  testID?: string;
  revisionCount?: number;
}) {
  const meta = statusMeta[status] || statusMeta["draft"];
  return (
    <HoverCard onPress={onPress} testID={testID} padding={spacing.lg}>
      <View style={{ flexDirection: "row", alignItems: "flex-start", gap: spacing.md }}>
        <View style={{ flex: 1, minWidth: 0, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
            <Text style={[type.mono, { fontWeight: "600" }]}>{number}</Text>
            {revisionCount && revisionCount > 0 ? (
              <Text style={type.caption}>· Rev {revisionCount}</Text>
            ) : null}
          </View>
          <Text style={type.titleSm} numberOfLines={1}>{projectName || customerName}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
            <Text style={type.caption} numberOfLines={1}>{customerName}</Text>
            <Text style={type.caption}>·</Text>
            <Text style={type.caption}>{itemCount} items</Text>
            {roomCount ? <><Text style={type.caption}>·</Text><Text style={type.caption}>{roomCount} rooms</Text></> : null}
            {updatedAt ? <><Text style={type.caption}>·</Text><Text style={type.caption}>{updatedAt}</Text></> : null}
          </View>
        </View>
        <View style={{ alignItems: "flex-end", gap: spacing.sm, flexShrink: 0 }}>
          <Text style={{
            fontSize: 16, fontFamily: type.titleMd.fontFamily,
            fontWeight: "700", color: colors.onSurface,
            fontVariant: ["tabular-nums"],
          }}>₹{grandTotal.toLocaleString("en-IN")}</Text>
          <View style={{
            paddingHorizontal: spacing.sm, height: 22,
            borderRadius: radius.sm, borderWidth: StyleSheet.hairlineWidth,
            borderColor: (meta as any).border, backgroundColor: (meta as any).bg,
            justifyContent: "center",
          }}>
            <Text style={{
              fontSize: 11, fontFamily: type.titleMd.fontFamily,
              fontWeight: "700", color: (meta as any).fg,
            }}>{(meta as any).label.toUpperCase()}</Text>
          </View>
        </View>
      </View>
    </HoverCard>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// CustomerCard — list item for the Customers index.
// ───────────────────────────────────────────────────────────────────────────
export function CustomerCard({
  name, email, city, phone, onPress, testID, lifetimeValue,
}: {
  name: string;
  email?: string | null;
  city?: string | null;
  phone?: string | null;
  tier: "retail" | "trade" | "vip";
  lifetimeValue?: number | null;
  onPress?: () => void;
  testID?: string;
}) {
  const initials = name.split(/\s+/).map(w => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <HoverCard onPress={onPress} testID={testID} padding={spacing.md}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.md }}>
        <View style={{
          width: 44, height: 44, borderRadius: radius.pill,
          backgroundColor: colors.brandTint,
          alignItems: "center", justifyContent: "center",
          flexShrink: 0,
        }}>
          <Text style={{
            fontSize: 15, fontFamily: type.titleMd.fontFamily,
            fontWeight: "700", color: colors.brand, letterSpacing: -0.2,
          }}>{initials}</Text>
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={type.titleSm} numberOfLines={1}>{name}</Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, flexWrap: "wrap" }}>
            {email ? <Text style={type.caption} numberOfLines={1}>{email}</Text> : null}
            {city ? <><Text style={type.caption}>·</Text><Text style={type.caption}>{city}</Text></> : null}
            {phone ? <><Text style={type.caption}>·</Text><Text style={type.caption}>{phone}</Text></> : null}
          </View>
        </View>
        <View style={{ alignItems: "flex-end", gap: 6, flexShrink: 0 }}>
          {typeof lifetimeValue === "number" && lifetimeValue > 0 ? (
            <Text style={{
              fontSize: 14, fontFamily: type.titleMd.fontFamily,
              fontWeight: "700", color: colors.onSurface,
              fontVariant: ["tabular-nums"],
            }}>₹{lifetimeValue.toLocaleString("en-IN")}</Text>
          ) : null}

        </View>
      </View>
    </HoverCard>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// PurchaseCard — Kanban card for Purchases board.
// ───────────────────────────────────────────────────────────────────────────
export function PurchaseCard({
  number, brandName, customerName, itemCount, grandTotal, dueDays, status,
  onPress, testID,
}: {
  number: string;
  brandName?: string | null;
  customerName?: string | null;
  itemCount?: number;
  grandTotal: number;
  dueDays?: number | null;
  status: string;
  onPress?: () => void;
  testID?: string;
}) {
  const meta = statusMeta[status] || statusMeta["ordered"];
  const dueTone = !dueDays ? null : dueDays < 0 ? "danger" : dueDays <= 3 ? "warning" : "brand";
  const dueBg = dueTone ? {
    danger:  { bg: colors.errorBg,   fg: colors.error },
    warning: { bg: colors.warningBg, fg: colors.warning },
    brand:   { bg: colors.brandTint, fg: colors.brand },
  }[dueTone] : null;

  return (
    <HoverCard onPress={onPress} testID={testID} padding={spacing.md}>
      <View style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
          <Text style={[type.mono, { fontWeight: "600" }]} numberOfLines={1}>{number}</Text>
          <View style={{
            paddingHorizontal: spacing.sm, height: 20, borderRadius: radius.sm,
            backgroundColor: (meta as any).bg, justifyContent: "center",
          }}>
            <Text style={{
              fontSize: 10, fontFamily: type.titleMd.fontFamily,
              fontWeight: "700", color: (meta as any).fg, letterSpacing: 0.4,
            }}>{(meta as any).label.toUpperCase()}</Text>
          </View>
        </View>
        {brandName ? <Text style={type.titleSm} numberOfLines={1}>{brandName}</Text> : null}
        {customerName ? <Text style={type.caption} numberOfLines={1}>{customerName}</Text> : null}
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 4, gap: spacing.sm }}>
          <Text style={{
            fontSize: 15, fontFamily: type.titleMd.fontFamily,
            fontWeight: "700", color: colors.onSurface,
            fontVariant: ["tabular-nums"],
          }}>₹{grandTotal.toLocaleString("en-IN")}</Text>
          {typeof itemCount === "number" ? (
            <Text style={type.caption}>{itemCount} items</Text>
          ) : null}
        </View>
        {dueBg && dueDays !== null && dueDays !== undefined ? (
          <View style={{
            marginTop: 2, paddingHorizontal: spacing.sm, height: 22,
            borderRadius: radius.sm, backgroundColor: dueBg.bg,
            alignSelf: "flex-start", flexDirection: "row",
            alignItems: "center", gap: 4,
          }}>
            <Feather name="clock" size={iconSize.xs} color={dueBg.fg} />
            <Text style={{
              fontSize: 11, fontFamily: type.titleMd.fontFamily,
              fontWeight: "600", color: dueBg.fg,
            }}>
              {dueDays < 0 ? `${Math.abs(dueDays)}d overdue` : dueDays === 0 ? "Due today" : `Due in ${dueDays}d`}
            </Text>
          </View>
        ) : null}
      </View>
    </HoverCard>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// RoomCard — QB room summary card (used in the Rooms panel).
// ───────────────────────────────────────────────────────────────────────────
export function RoomCard({
  name, itemCount, total, active, onPress, testID,
}: {
  name: string;
  itemCount: number;
  total: number;
  active?: boolean;
  onPress?: () => void;
  testID?: string;
}) {
  return (
    <HoverCard
      onPress={onPress}
      testID={testID}
      padding={spacing.md}
      style={{
        borderColor: active ? colors.brand : colors.border,
        backgroundColor: active ? colors.brandTint : colors.surfaceSecondary,
      }}
    >
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}>
          <Text style={type.titleSm} numberOfLines={1}>{name}</Text>
          <Text style={type.caption}>{itemCount} items</Text>
        </View>
        <Text style={{
          fontSize: 15, fontFamily: type.titleMd.fontFamily,
          fontWeight: "700", color: colors.onSurface,
          fontVariant: ["tabular-nums"],
        }}>₹{total.toLocaleString("en-IN")}</Text>
      </View>
    </HoverCard>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ActivityRow — single event in a timeline. Icon tile · text · timestamp.
// ───────────────────────────────────────────────────────────────────────────
export function ActivityRow({
  icon, iconTone = "neutral", title, subtitle, timestamp, onPress, testID,
  isLast,
}: {
  icon: FeatherName;
  iconTone?: "brand" | "success" | "warning" | "danger" | "neutral";
  title: string;
  subtitle?: string;
  timestamp?: string;
  onPress?: () => void;
  testID?: string;
  isLast?: boolean;
}) {
  const map = {
    brand:   { bg: colors.brandTint,       fg: colors.brand },
    success: { bg: colors.successBg,       fg: colors.success },
    warning: { bg: colors.warningBg,       fg: colors.warning },
    danger:  { bg: colors.errorBg,         fg: colors.error },
    neutral: { bg: colors.surfaceTertiary, fg: colors.onSurfaceSecondary },
  }[iconTone];

  const Container: any = onPress ? Pressable : View;
  return (
    <Container
      testID={testID}
      onPress={onPress}
      style={({ pressed, hovered }: any) => ({
        flexDirection: "row",
        gap: spacing.md,
        paddingVertical: spacing.md,
        paddingHorizontal: onPress ? spacing.md : 0,
        borderRadius: onPress ? radius.sm : 0,
        backgroundColor: pressed ? colors.surfaceTertiary : hovered && onPress ? colors.surfaceSubtle : "transparent",
        borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: colors.divider,
      })}
    >
      <View style={{
        width: 32, height: 32, borderRadius: radius.pill,
        backgroundColor: map.bg,
        alignItems: "center", justifyContent: "center",
        flexShrink: 0,
      }}>
        <Feather name={icon} size={iconSize.md} color={map.fg} />
      </View>
      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
        <Text style={type.bodySm} numberOfLines={2}>{title}</Text>
        {subtitle ? <Text style={type.caption} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {timestamp ? <Text style={type.caption} numberOfLines={1}>{timestamp}</Text> : null}
    </Container>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Dropdown — anchored menu button with a list of options.
// Simplified: opens a modal-positioned menu below the anchor.
// ───────────────────────────────────────────────────────────────────────────
export function Dropdown({ label, icon, items, testID, variant = "secondary" }: {
  label: string; icon?: FeatherName;
  items: { label: string; icon?: FeatherName; onPress: () => void; tone?: "default" | "danger" }[];
  testID?: string; variant?: "primary" | "secondary" | "ghost";
}) {
  const foreground = variant === "primary" ? colors.onBrand : colors.onSurface;
  return <Menu triggerLabel={label} triggerTestID={testID} items={items.map(item => ({ ...item, tone: item.tone === "danger" ? "risk" : "ink" }))}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minHeight: 44,
      borderRadius: radius.sm, paddingHorizontal: 12, borderWidth: variant === "ghost" ? 0 : 1,
      borderColor: colors.border, backgroundColor: variant === "primary" ? colors.brand : variant === "ghost" ? "transparent" : colors.surfaceSecondary }}>
      {icon ? <Feather name={icon} size={16} color={foreground} /> : null}
      <Text style={{ fontFamily: type.body.fontFamily, fontWeight: "500", fontSize: 14, color: foreground, flexShrink: 1 }}>{label}</Text>
      <Feather name="chevron-down" size={14} color={foreground} />
    </View>
  </Menu>;
}

// ───────────────────────────────────────────────────────────────────────────
// Accordion — collapsible section with animated chevron.
// ───────────────────────────────────────────────────────────────────────────
export function Accordion({
  title, subtitle, children, defaultOpen, right, testID,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  right?: React.ReactNode;
  testID?: string;
}) {
  const [open, setOpen] = useState(!!defaultOpen);
  const reducedMotion = useReducedMotion();
  const rotate = useRef(new Animated.Value(defaultOpen ? 1 : 0)).current;

  useEffect(() => {
    const animation = Animated.timing(rotate, {
      toValue: open ? 1 : 0,
      duration: reducedMotion ? 0 : motion.hover.duration,
      easing: Easing.inOut(Easing.ease),
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start();
    return () => animation.stop();
  }, [open, reducedMotion, rotate]);

  const rotation = rotate.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "180deg"] });

  return (
    <View testID={testID} style={{
      borderRadius: radius.md,
      backgroundColor: colors.surfaceSecondary,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.border,
      overflow: "hidden",
    }}>
      <Pressable
        onPress={() => setOpen((v) => !v)}
        style={({ pressed, hovered }: any) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: spacing.md,
          paddingHorizontal: spacing.lg,
          paddingVertical: spacing.md,
          backgroundColor: pressed ? colors.surfaceTertiary : hovered ? colors.surfaceSubtle : "transparent",
        })}
      >
        <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
          <Text style={type.titleSm} numberOfLines={1}>{title}</Text>
          {subtitle ? <Text style={type.caption} numberOfLines={1}>{subtitle}</Text> : null}
        </View>
        {right}
        <Animated.View style={{ transform: [{ rotate: rotation }] }}>
          <Feather name="chevron-down" size={iconSize.md} color={colors.onSurfaceMuted} />
        </Animated.View>
      </Pressable>
      {open ? (
        <View style={{
          paddingHorizontal: spacing.lg, paddingBottom: spacing.lg, paddingTop: 0,
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: colors.divider,
        }}>
          <View style={{ marginTop: spacing.md }}>{children}</View>
        </View>
      ) : null}
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Stepper — multi-step form indicator with active/complete/pending states.
// ───────────────────────────────────────────────────────────────────────────
export function Stepper({
  steps, current, testID,
}: {
  steps: { label: string; sublabel?: string }[];
  current: number; // 0-indexed
  testID?: string;
}) {
  return (
    <View testID={testID} style={{ flexDirection: "row", alignItems: "flex-start", gap: 0 }}>
      {steps.map((s, i) => {
        const state: "complete" | "active" | "pending" =
          i < current ? "complete" : i === current ? "active" : "pending";
        const bg =
          state === "complete" ? colors.brand
          : state === "active" ? colors.brandTint
          : colors.surfaceTertiary;
        const border =
          state === "active" ? colors.brand
          : state === "complete" ? colors.brand
          : colors.border;
        const fg =
          state === "complete" ? colors.onBrand
          : state === "active" ? colors.brand
          : colors.onSurfaceMuted;
        return (
          <View key={i} style={{ flexDirection: "row", alignItems: "center", flex: i === steps.length - 1 ? 0 : 1 }}>
            <View style={{ alignItems: "center", gap: 6, minWidth: 60 }}>
              <View style={{
                width: 28, height: 28, borderRadius: radius.pill,
                backgroundColor: bg,
                borderWidth: state === "active" ? 2 : StyleSheet.hairlineWidth,
                borderColor: border,
                alignItems: "center", justifyContent: "center",
              }}>
                {state === "complete" ? (
                  <Feather name="check" size={iconSize.md} color={fg} />
                ) : (
                  <Text style={{
                    fontSize: 12, fontFamily: type.titleMd.fontFamily,
                    fontWeight: "700", color: fg,
                  }}>{i + 1}</Text>
                )}
              </View>
              <Text style={{
                fontSize: 11, fontFamily: type.titleMd.fontFamily,
                fontWeight: state === "active" ? "700" : "500",
                color: state === "pending" ? colors.onSurfaceMuted : colors.onSurface,
                textAlign: "center",
              }} numberOfLines={2}>{s.label}</Text>
            </View>
            {i < steps.length - 1 ? (
              <View style={{
                flex: 1,
                height: 2,
                backgroundColor: i < current ? colors.brand : colors.border,
                marginTop: 14,
                marginHorizontal: 4,
              }} />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

// ───────────────────────────────────────────────────────────────────────────
// ConfirmDialog — center modal for destructive confirmations.
// Wraps the Modal primitive with tone-coded icon + title + description + actions.
// ───────────────────────────────────────────────────────────────────────────
export function ConfirmDialog({
  visible, onClose, onConfirm, title, description,
  confirmLabel = "Confirm", cancelLabel = "Cancel", tone = "brand", loading,
  testID,
}: {
  visible: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "brand" | "danger" | "warning" | "success";
  loading?: boolean;
  testID?: string;
}) {
  const toneMap = {
    brand:   { icon: "info",          bg: colors.brandTint, fg: colors.brand,   variant: "primary" as const },
    danger:  { icon: "alert-triangle",bg: colors.errorBg,   fg: colors.error,   variant: "danger"  as const },
    warning: { icon: "alert-circle",  bg: colors.warningBg, fg: colors.warning, variant: "primary" as const },
    success: { icon: "check-circle",  bg: colors.successBg, fg: colors.success, variant: "primary" as const },
  }[tone];

  return (
    <_Sheet
      visible={visible}
      onClose={onClose}
      variant="modal"
      title={title}
      subtitle={description}
      testID={testID}
      width={440}
      footer={
        <>
          <_Button label={cancelLabel} variant="secondary" onPress={onClose} size="md" />
          <View style={{ flex: 1 }} />
          <_Button
            label={confirmLabel}
            variant={toneMap.variant}
            onPress={onConfirm}
            loading={loading}
            size="md"
            testID={testID ? `${testID}-confirm` : undefined}
          />
        </>
      }
    >
      <View style={{ padding: spacing.xl, gap: spacing.md, alignItems: "center" }}>
        <View style={{
          width: 56, height: 56, borderRadius: radius.pill,
          backgroundColor: toneMap.bg,
          alignItems: "center", justifyContent: "center",
        }}>
          <Feather name={toneMap.icon as any} size={iconSize.hero} color={toneMap.fg} />
        </View>
      </View>
    </_Sheet>
  );
}
