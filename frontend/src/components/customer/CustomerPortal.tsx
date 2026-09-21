import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import type { ComponentProps, ReactNode } from "react";
import {
  Pressable,
  RefreshControl,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";

import { Card, EmptyState, ErrorState, IconButton, Skeleton } from "@/src/components/ui";
import { BuildConLogo } from "@/src/design/BrandLogo";
import { colors, layout, radius, spacing, type } from "@/src/theme/tokens";
import { useBp } from "@/src/design/responsive";

type CustomerHeaderProps = {
  title?: string;
  subtitle?: string | null;
  back?: () => void;
  onLogout?: () => void;
  brand?: boolean;
  customerName?: string | null;
};

export function CustomerHeader({
  title,
  subtitle,
  back,
  onLogout,
  brand = false,
  customerName,
}: CustomerHeaderProps) {
  if (brand) {
    return (
      <View style={styles.brandHeader}>
        <View style={styles.brandHeaderTop}>
          <BuildConLogo height={28} />
          {onLogout ? (
            <Pressable
              testID="portal-logout"
              accessibilityRole="button"
              accessibilityLabel="Sign out"
              onPress={onLogout}
              style={({ pressed }) => [styles.logoutButton, { opacity: pressed ? 0.82 : 1 }]}
            >
              <Feather name="log-out" size={15} color={colors.onSurface} />
              <Text style={styles.logoutLabel}>Sign out</Text>
            </Pressable>
          ) : null}
        </View>
        <Text style={styles.brandEyebrow}>Welcome</Text>
        <Text accessibilityRole="header" style={styles.brandTitle} numberOfLines={3}>
          {customerName || "Your BuildCon House portal"}
        </Text>
        <Text style={styles.brandSubtitle}>Your quotations, ready when you are.</Text>
      </View>
    );
  }

  return (
    <View style={styles.pageHeader}>
      <View style={styles.pageHeaderRow}>
        {back ? <IconButton icon="chevron-left" onPress={back} size={44} tone="surface" accessibilityLabel="Back" /> : null}
        <View style={styles.pageHeaderCopy}>
          <Text accessibilityRole="header" style={styles.pageTitle} numberOfLines={3}>{title || "BuildCon House"}</Text>
          {subtitle ? <Text style={styles.pageSubtitle} numberOfLines={3}>{subtitle}</Text> : null}
        </View>
      </View>
    </View>
  );
}

export function CustomerPage({
  header,
  children,
  contentStyle,
  refreshControl,
  testID,
}: {
  header: ReactNode;
  children: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  refreshControl?: ComponentProps<typeof RefreshControl>;
  testID?: string;
}) {
  const insets = useSafeAreaInsets();
  const { isPhone, gutter } = useBp();
  return (
    <SafeAreaView testID={testID} style={styles.safeArea} edges={["top", "left", "right"]}>
      {header}
      <ScrollView
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        refreshControl={refreshControl ? <RefreshControl {...refreshControl} /> : undefined}
        contentContainerStyle={[
          styles.pageContent,
          { paddingHorizontal: gutter, paddingTop: isPhone ? spacing.md : spacing.lg },
          { paddingBottom: Math.max(insets.bottom + spacing.xl, spacing.xxl) },
          contentStyle,
        ]}
      >
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function CustomerSectionHeading({ title, count }: { title: string; count?: number }) {
  return (
    <View style={styles.sectionHeading}>
      <Text accessibilityRole="header" style={type.overline}>{title}</Text>
      {typeof count === "number" ? <Text style={type.caption}>{count}</Text> : null}
    </View>
  );
}

export function CustomerSkeletonCard({ detail = false }: { detail?: boolean }) {
  return (
    <Card style={styles.skeletonCard}>
      <Skeleton w="42%" />
      <Skeleton w="78%" h={detail ? 28 : 22} />
      <Skeleton w="58%" />
      {detail ? <Skeleton w="100%" h={44} /> : null}
    </Card>
  );
}

export function CustomerError({ onRetry, detail }: { onRetry: () => void; detail?: boolean }) {
  return (
    <ErrorState
      title={detail ? "Quotation unavailable" : "Couldn’t load quotations"}
      subtitle="Check your connection and try again."
      onRetry={onRetry}
    />
  );
}

export function CustomerEmpty({ title, subtitle }: { title: string; subtitle: string }) {
  return <EmptyState icon="file-text" title={title} subtitle={subtitle} tone="brand" />;
}

export function CustomerFooterLinks() {
  const router = useRouter();
  return (
    <View style={styles.footerLinks}>
      <Pressable accessibilityRole="link" testID="portal-privacy-link" onPress={() => router.push("/privacy")} hitSlop={layout.hitSlop} style={styles.footerLinkButton}>
        <Text style={styles.footerLink}>Privacy</Text>
      </Pressable>
      <Pressable accessibilityRole="link" testID="portal-terms-link" onPress={() => router.push("/terms")} hitSlop={layout.hitSlop} style={styles.footerLinkButton}>
        <Text style={styles.footerLink}>Terms</Text>
      </Pressable>
    </View>
  );
}

export function formatCustomerDate(value: string | undefined, long = false) {
  if (!value) return "Date unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Date unavailable";
  return date.toLocaleDateString("en-IN", long
    ? { day: "numeric", month: "long", year: "numeric" }
    : { day: "numeric", month: "short", year: "numeric" });
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.surface },
  pageContent: { width: "100%", maxWidth: 960, alignSelf: "center", padding: spacing.lg, gap: spacing.lg },
  brandHeader: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.xl,
    backgroundColor: colors.surfaceSecondary,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    gap: spacing.sm,
  },
  brandHeaderTop: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md },
  logoutButton: {
    minHeight: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.onSurfaceSecondary,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  logoutLabel: { color: colors.onSurface, fontFamily: type.bodyStrong.fontFamily, fontSize: 13, fontWeight: "600" },
  brandEyebrow: { ...type.overline, color: colors.onSurfaceMuted, marginTop: spacing.md },
  brandTitle: { color: colors.onSurface, fontFamily: type.displayMd.fontFamily, fontSize: 28, lineHeight: 34, fontWeight: "700", letterSpacing: -0.3 },
  brandSubtitle: { ...type.bodySm, color: colors.onSurfaceMuted },
  pageHeader: { paddingHorizontal: spacing.lg, paddingVertical: spacing.md, backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  pageHeaderRow: { flexDirection: "row", alignItems: "flex-start", gap: spacing.sm },
  pageHeaderCopy: { flex: 1, minWidth: 0, paddingTop: spacing.sm },
  pageTitle: { ...type.titleLg, fontSize: 22, lineHeight: 28 },
  pageSubtitle: { ...type.bodyMuted, marginTop: 2 },
  sectionHeading: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  skeletonCard: { gap: spacing.md },
  footerLinks: { flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.xl, paddingTop: spacing.sm },
  footerLinkButton: { minHeight: 44, justifyContent: "center" },
  footerLink: { ...type.caption, color: colors.onSurfaceMuted },
});
