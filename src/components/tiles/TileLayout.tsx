import Feather from "@expo/vector-icons/Feather";
import { Button as SharedButton } from "@/src/design/controls";
import { NavigationTabs } from "@/src/design/NavigationTabs";
import { PageHeader as SharedPageHeader } from "@/src/design/PageHeader";
// frontend/src/components/tiles/TileLayout.tsx
// Page chrome and controls shared by every Tile Orders screen.
//
// The module's spacing contract, applied here once instead of being retyped
// (and mistyped) per screen:
//   page gutter    32 desktop · 24 tablet · 20 phone
//   section gap    32
//   card padding   24
//   control gap    12 minimum, 16 between groups
//   tap target     36 small · 40 medium · 44 large
// Nothing in Tile Orders should set its own horizontal page padding, its own
// button metrics, or its own section rhythm — it comes from here.
import { type ReactNode } from "react";
import { Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { useBreakpoint } from "@/src/hooks/use-breakpoint";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

const webCursor = Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null;

/** Page gutter — the single answer to "how far from the edge does content sit". */
export function usePageGutter() {
  const { isPhone, isTablet } = useBreakpoint();
  return isPhone ? 16 : isTablet ? 24 : 32;
}

export function PageShell({
  children, footer, testID,
}: { children: ReactNode; footer?: ReactNode; testID?: string }) {
  const gutter = usePageGutter();
  const { isPhone } = useBreakpoint();
  return (
    <SafeAreaView
      style={styles.safe}
      // The phone AppScaffold already owns the top inset. Tablet/desktop
      // routes retain their standalone inset because they do not mount in it.
      edges={isPhone ? [] : ["top"]}
      testID={testID}
    >
      <ScrollView
        style={styles.pageScroll}
        contentContainerStyle={[
          styles.pageContent,
          { paddingHorizontal: gutter },
          // Clears the sticky action bar so the last table row is never
          // trapped underneath it.
          footer ? { paddingBottom: 112 } : null,
        ]}
      >
        {/* An operations table earns its width — these screens are read as
            columns of figures, not prose — so the cap is set high enough that
            a 24"/27" monitor is filled edge to edge and only a very wide
            display sees a margin. */}
        <View style={styles.pageInner}>{children}</View>
      </ScrollView>
      {footer}
    </SafeAreaView>
  );
}

export function CenteredState({ children }: { children: ReactNode }) {
  const { isPhone } = useBreakpoint();
  return (
    <SafeAreaView style={[styles.safe, styles.centered]} edges={isPhone ? [] : ["top"]}>
      <View style={styles.centeredInner}>{children}</View>
    </SafeAreaView>
  );
}

export function BackLink({ label, onPress, testID }: { label: string; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button" accessibilityLabel={label}
      onPress={onPress}
      style={({ hovered }: any) => [styles.backLink, hovered ? styles.backLinkHovered : null, webCursor]}
    >
      <Text style={styles.backLinkArrow}>←</Text>
      <Text style={type.bodyMuted}>{label}</Text>
    </Pressable>
  );
}

export function PageHeader({ eyebrow, title, subtitle, actions }: {
  eyebrow?: string; title: string; subtitle?: string; actions?: ReactNode;
}) { return <SharedPageHeader embedded title={title} overline={eyebrow} subtitle={subtitle} actions={actions} />; }

export function Section({ children, testID }: { children: ReactNode; testID?: string }) {
  return <View style={styles.section} testID={testID}>{children}</View>;
}

export function SectionHeader({
  title, meta, actions,
}: { title: string; meta?: ReactNode; actions?: ReactNode }) {
  const { isPhone, bp } = useBreakpoint();
  const compact = isPhone || bp === "tabletPortrait";
  return (
    <View style={[styles.sectionHeader, compact ? styles.sectionHeaderCompact : null]}>
      <View style={styles.sectionHeaderText}>
        <Text style={type.titleMd} numberOfLines={1}>{title}</Text>
        {meta}
      </View>
      {actions ? <View style={[styles.sectionHeaderActions, compact ? styles.sectionHeaderActionsCompact : null]}>{actions}</View> : null}
    </View>
  );
}

export function Card({ children, testID }: { children: ReactNode; testID?: string }) {
  const { isPhone } = useBreakpoint();
  return <View style={[styles.card, isPhone ? styles.cardPhone : null]} testID={testID}>{children}</View>;
}

// ── Controls ────────────────────────────────────────────────────────────────

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

export function Button({ label, onPress, variant = "secondary", size = "md", disabled, testID, fullWidth }: {
  label: string; onPress?: () => void; variant?: ButtonVariant; size?: ButtonSize;
  disabled?: boolean; testID?: string; fullWidth?: boolean;
}) { return <SharedButton label={label} onPress={onPress} variant={variant} size={size} disabled={disabled} testID={testID} full={fullWidth} />; }

/**
 * A horizontal cluster of buttons with the module's minimum 12px separation.
 * Buttons never touch, and never stack raggedly — they wrap as whole units.
 */
export function ButtonGroup({ children, align = "left" }: { children: ReactNode; align?: "left" | "right" }) {
  const { isPhone, bp } = useBreakpoint();
  const compact = isPhone || bp === "tabletPortrait";
  return (
    <View style={[styles.buttonGroup, align === "right" ? styles.buttonGroupRight : null, compact ? styles.buttonGroupCompact : null]}>
      {children}
    </View>
  );
}

export function SearchField({
  value, onChangeText, onSubmit, placeholder, testID, accessibilityLabel = "Search",
}: {
  value: string;
  onChangeText: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  testID?: string;
  /** The placeholder is not a reliable accessible name once the user types. */
  accessibilityLabel?: string;
}) {
  const { isPhone } = useBreakpoint();
  return (
    <View style={[styles.searchWrap, isPhone ? styles.searchWrapPhone : null]}>
      <Feather name="search" size={18} color={colors.onSurfaceMuted} />
      <TextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        placeholder={placeholder}
        placeholderTextColor={colors.onSurfaceSubtle}
        accessibilityLabel={accessibilityLabel}
        style={[styles.searchInput, { fontSize: 16, minWidth: 0 }]}
        returnKeyType="search"
      />
    </View>
  );
}

export function FilterChip({
  label, active, onPress, testID,
}: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <Pressable
      testID={testID}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      aria-pressed={active} accessibilityState={{ selected: active }}
      style={({ hovered }: any) => [
        styles.chip,
        active ? styles.chipActive : null,
        hovered && !active ? styles.chipHovered : null,
        webCursor,
      ]}
    >
      <Text style={[styles.chipLabel, active ? styles.chipLabelActive : null]}>{label}</Text>
    </Pressable>
  );
}

/** Tab bar — segmented, underlined, the page's primary view switch. */
export function TabBar<K extends string>({
  tabs, value, onChange, testIDPrefix,
}: {
  tabs: [K, string][];
  value: K;
  onChange: (key: K) => void;
  testIDPrefix?: string;
}) {
  return <NavigationTabs value={value} onChange={onChange} testID={testIDPrefix} options={tabs.map(([value, label]) => ({ value, label }))} />;
}

/**
 * Toolbar above a table: search on the left, filters and the create action on
 * the right, wrapping as coherent groups instead of a ragged button soup.
 */
export function Toolbar({ search, filters, actions }: { search?: ReactNode; filters?: ReactNode; actions?: ReactNode }) {
  const { isPhone, bp } = useBreakpoint();
  const compact = isPhone || bp === "tabletPortrait";
  return (
    <View style={[styles.toolbar, compact ? styles.toolbarPhone : null]}>
      {search ? <View style={styles.toolbarSearch}>{search}</View> : null}
      <View style={[styles.toolbarTrailing, compact ? styles.toolbarTrailingPhone : null]}>
        {filters ? (compact ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.toolbarFilterScroller} contentContainerStyle={styles.toolbarFilters}>
            {filters}
          </ScrollView>
        ) : <View style={styles.toolbarFilters}>{filters}</View>) : null}
        {actions ? <View style={styles.toolbarActions}>{actions}</View> : null}
      </View>
    </View>
  );
}

/** One figure and its label. Metrics read as a row of these, never as cards. */
export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: "default" | "brand" | "warn" }) {
  return (
    <View style={styles.stat}>
      <Text
        style={[
          styles.statValue,
          tone === "brand" ? { color: colors.brand } : tone === "warn" ? { color: colors.warningFg } : null,
        ]}
      >
        {value}
      </Text>
      <Text style={styles.statLabel}>{label}</Text>
    </View>
  );
}

export function StatRow({ children, testID }: { children: ReactNode; testID?: string }) {
  return <View style={styles.statRow} testID={testID}>{children}</View>;
}

/** Sticky bottom action bar — batch operations live here, never in the scroll. */
export function ActionBar({ children, testID }: { children: ReactNode; testID?: string }) {
  const gutter = usePageGutter();
  const { isPhone } = useBreakpoint();
  return (
    <View style={[styles.actionBar, { paddingHorizontal: gutter }]} testID={testID}>
      <View style={[styles.actionBarInner, isPhone ? styles.actionBarInnerPhone : null]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.surface },
  pageScroll: { flex: 1 },
  pageContent: { paddingTop: spacing.s24, paddingBottom: spacing.s48, alignItems: "center" },
  pageInner: { width: "100%", maxWidth: 1680 },

  centered: { justifyContent: "center", alignItems: "center", padding: spacing.s32 },
  centeredInner: { alignItems: "center", gap: spacing.lg, maxWidth: 420 },

  backLink: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8,
    alignSelf: "flex-start",
    minHeight: 44,
    paddingRight: spacing.s8,
    marginBottom: spacing.lg,
  },
  backLinkHovered: { opacity: 0.7 },
  backLinkArrow: { ...type.bodyMuted, fontSize: 16, lineHeight: 20 },

  pageHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: spacing.s24,
    flexWrap: "wrap",
  },
  pageHeaderText: { flexShrink: 1, minWidth: 260, gap: spacing.s4 },
  pageHeaderActions: { flexDirection: "row", alignItems: "center", gap: spacing.s12, flexWrap: "wrap" },
  pageHeaderCompact: { alignItems: "stretch" },
  pageHeaderTextCompact: { minWidth: 0, width: "100%" },
  pageHeaderActionsCompact: { width: "100%", justifyContent: "flex-start" },
  eyebrow: { ...type.overline, color: colors.brand, marginBottom: spacing.s4 },
  pageSubtitle: { maxWidth: 720 },

  section: { marginTop: spacing.s32 },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
    marginBottom: spacing.lg,
    flexWrap: "wrap",
  },
  sectionHeaderText: { flexDirection: "row", alignItems: "center", gap: spacing.s12, flexShrink: 1, minWidth: 0 },
  sectionHeaderActions: { flexDirection: "row", alignItems: "center", gap: spacing.s12 },
  sectionHeaderCompact: { alignItems: "stretch" },
  sectionHeaderActionsCompact: { width: "100%" },

  card: {
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.s24,
  },
  cardPhone: { padding: spacing.lg },

  buttonBase: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.sm,
    borderWidth: 1,
  },
  buttonPrimary: { backgroundColor: colors.brand, borderColor: colors.brand },
  buttonPrimaryHovered: { backgroundColor: colors.brandHover, borderColor: colors.brandHover },
  buttonSecondary: { backgroundColor: colors.surfaceSecondary, borderColor: colors.borderStrong },
  buttonSecondaryHovered: { backgroundColor: colors.surfaceTertiary, borderColor: colors.brandBorder },
  buttonGhost: { backgroundColor: "transparent", borderColor: "transparent" },
  buttonDanger: { backgroundColor: colors.surfaceSecondary, borderColor: colors.errorBorder },
  buttonDangerHovered: { backgroundColor: colors.errorBg },
  buttonPressed: { opacity: 0.85 },
  buttonDisabled: { opacity: 0.4 },
  buttonLabel: { fontFamily: type.bodyStrong.fontFamily, fontWeight: "500", letterSpacing: -0.1 },
  buttonLabelPrimary: { color: colors.onBrand },
  buttonLabelSecondary: { color: colors.onSurface },
  buttonLabelDanger: { color: colors.errorFg },

  buttonGroup: { flexDirection: "row", alignItems: "center", gap: spacing.s12, flexWrap: "wrap" },
  buttonGroupRight: { justifyContent: "flex-end" },
  buttonGroupCompact: { alignItems: "stretch" },

  searchWrap: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.s8,
    height: 44,
    minWidth: 260,
    paddingHorizontal: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceSecondary,
  },
  searchWrapPhone: { minWidth: 0, width: "100%" },
  searchIcon: { ...type.body, color: colors.onSurfaceMuted, fontSize: 16 },
  searchInput: {
    flex: 1,
    ...type.body,
    color: colors.onSurface,
    height: "100%",
  },

  chip: {
    // 40px matches the search field and the toolbar's primary button, so the
    // whole control band reads as one aligned row rather than three sizes.
    height: 44,
    justifyContent: "center",
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surfaceSecondary,
  },
  chipActive: { backgroundColor: colors.brandTint, borderColor: colors.brandBorder },
  chipHovered: { backgroundColor: colors.surfaceTertiary },
  chipLabel: { ...type.captionStrong, fontSize: 12 },
  chipLabelActive: { color: colors.brandHover },

  tabScroller: { width: "100%" },
  tabBar: {
    flexDirection: "row",
    alignItems: "stretch",
    gap: spacing.s24,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  tab: { height: 44, justifyContent: "center", borderBottomWidth: 2, borderBottomColor: "transparent" },
  tabActive: { borderBottomColor: colors.brand },
  tabHovered: { borderBottomColor: colors.borderStrong },
  tabLabel: { ...type.bodyStrong, color: colors.onSurfaceMuted },
  tabLabelActive: { color: colors.onSurface },

  toolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
    marginBottom: spacing.lg,
    flexWrap: "wrap",
  },
  toolbarPhone: { alignItems: "stretch" },
  toolbarSearch: { flexShrink: 1, flexGrow: 1, maxWidth: 420, minWidth: 240 },
  toolbarTrailing: { flexDirection: "row", alignItems: "center", gap: spacing.lg, flexWrap: "wrap" },
  toolbarTrailingPhone: { width: "100%", alignItems: "stretch" },
  toolbarFilterScroller: { width: "100%" },
  // 12px is the module's floor for separation between two controls; 8px read
  // as chips touching each other.
  toolbarFilters: { flexDirection: "row", alignItems: "center", gap: spacing.s12, flexWrap: "wrap" },
  toolbarActions: { flexDirection: "row", alignItems: "center", gap: spacing.s12 },

  statRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    // Wide columns, tighter rows: when the stats wrap onto a second line the
    // two lines belong to one block and should not read as two blocks.
    columnGap: spacing.s40,
    rowGap: spacing.s24,
    backgroundColor: colors.surfaceSecondary,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingVertical: spacing.s20,
    paddingHorizontal: spacing.s24,
  },
  stat: { minWidth: 104, gap: spacing.s4 },
  statValue: {
    fontFamily: type.displayMd.fontFamily,
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: -0.3,
    color: colors.onSurface,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  statLabel: { ...type.caption },

  actionBar: {
    backgroundColor: colors.surfaceSecondary,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingVertical: spacing.lg,
    alignItems: "center",
  },
  actionBarInner: {
    width: "100%",
    maxWidth: 1920,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
    flexWrap: "wrap",
  },
  actionBarInnerPhone: { alignItems: "stretch" },
});
