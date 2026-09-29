import { ConnectionStatus } from "@/src/design/ConnectionStatus";
import { PRIMARY, SECONDARY, TILES_ITEMS, type NavItem } from "@/src/design/navigation";
// ─────────────────────────────────────────────────────────────────────────────
// BuildCon House · Shell.
// Desktop: quiet 240px sidebar. Tablet: 64px icon rail. Phone: bottom bar.
// One brass bar marks where you are. The command palette lives here (⌘K).
// ─────────────────────────────────────────────────────────────────────────────
import { Feather } from "@expo/vector-icons";
import { Slot, useRouter, useSegments } from "expo-router";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  Avatar, FeatherName, Hairline, KeyCap, Menu, Sheet, usePalette,
} from "@/src/design/components";
import { PaletteProvider } from "@/src/design/CommandPalette";
import { useBp } from "@/src/design/responsive";
import { color, font, layout, radius, space } from "@/src/design/tokens";
import { BuildConLogo } from "@/src/design/BrandLogo";
import { useAuth } from "@/src/state/auth";
import { useModuleAccess, usePermissionMatrix } from "@/src/hooks/use-permissions";
import { staffLandingPath } from "@/src/access-profiles";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { AppScaffold } from "@/src/components/mobile/AppScaffold";
import { storage } from "@/src/utils/storage";
import { FURNITURE_FLOOR_ID, KITCHEN_FLOOR_ID, SANITARY_FLOOR_ID, TILES_FLOOR_ID, floorDisplayLabel, floorLandingPath } from "@/src/constants/floors";

function isNavActive(item: NavItem, segments: string[]): boolean {
  // The root notebook route is Walk-ins. It must not remain highlighted when
  // its sibling Quotation Follow-up route is active.
  if (item.href.endsWith("/notebook/kitchen")) {
    return segments.includes("kitchen") && !segments.includes("quotation-follow-up");
  }
  if (item.href.endsWith("/notebook/furniture")) {
    return segments.includes("furniture") && !segments.includes("quotation-follow-up");
  }
  return segments.includes(item.match);
}

const roleLabel: Record<string, string> = {
  owner: "Owner", admin: "Admin", manager: "Manager", sales: "Sales",
  purchase: "Purchase", warehouse: "Warehouse", accounts: "Accounts", worker: "Worker",
};

function Wordmark({ compact }: { compact?: boolean }) {
  if (compact) {
    return (
      <View style={styles.monogram}>
        <Text style={{ fontFamily: font.serif, fontSize: 15, color: color.onAction }}>B</Text>
      </View>
    );
  }
  return <BuildConLogo height={32} />;
}

// ── Sidebar item — the brass bar is the only accent in the chrome. ─────────
function SideItem({ item, active, onPress, compact = false }: { item: NavItem; active: boolean; onPress: () => void; compact?: boolean }) {
  return (
    <Pressable
      testID={`nav-${item.match}`}
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={item.label}
        {...(Platform.OS === "web" ? { title: item.label } : {})}
      accessibilityState={{ selected: active }}
      style={({ pressed, hovered }: any) => [
        styles.sideItem,
        compact && styles.sideItemCompact,
        { backgroundColor: active ? color.accentTint : pressed || hovered ? color.hoverWash : "transparent" },
        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
      ]}
    >
      <View style={[styles.brassBar, { backgroundColor: active ? color.brass : "transparent" }]} />
      <Feather name={item.icon} size={16} color={active ? color.action : color.inkSoft} />
      {!compact ? <Text
        style={{
          fontFamily: active ? font.semibold : font.medium,
          fontWeight: active ? "600" : "500",
          fontSize: 13.5, letterSpacing: -0.1,
          color: active ? color.actionHover : color.inkMid,
        }}
      >
        {item.label}
      </Text> : null}
    </Pressable>
  );
}

function SearchTrigger() {
  const palette = usePalette();
  return (
    <Pressable
      testID="open-palette"
      accessibilityRole="button"
      accessibilityLabel="Search"
      onPress={palette.open}
      style={({ hovered }: any) => [
        styles.searchTrigger,
        { borderColor: hovered ? color.lineStrong : color.line, backgroundColor: color.surface },
        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
      ]}
    >
      <Feather name="search" size={14} color={color.inkSoft} />
      <Text style={{ flex: 1, fontFamily: font.regular, fontSize: 13, color: color.inkSoft }}>Search</Text>
      {Platform.OS === "web" ? <KeyCap label="⌘K" /> : null}
    </Pressable>
  );
}

function FloorSwitcher({ compact = false }: { compact?: boolean }) {
  const { access, floors, selectedFloorId, selectFloor } = useFloorAccess();
  const router = useRouter();
  const segments = useSegments() as string[];
  const selected = floors.find((floor) => floor.id === selectedFloorId);
  if (!access || floors.length < 2) return null;
  const pick = (id: string) => {
    if (id === selectedFloorId) return;

    // The hook publishes synchronously; persistence happens in the
    // background. Mounted screens that consume the hook update immediately,
    // while the route only changes when the current screen belongs to the
    // floor we are leaving.
    void selectFloor(id).catch(() => {});
    if (!isRouteCompatibleWithFloor(segments, id)) {
      router.replace(`/(admin)${floorLandingPath(id)}` as any);
    }
  };
  // No "All floors" entry: an unscoped selection sends no X-Floor-Id at
  // all, which made every business module (Quotations, Purchases, Tile
  // Orders, Payments, Follow-ups…) return both business units' records at
  // once. One concrete floor is always active — company-wide reporting
  // lives in Sales Data's own explicit floor filter, not in the shell.
  const items = floors.map((floor) => ({
    label: `${floorDisplayLabel(floor)}${floor.id === selectedFloorId ? " · Active" : ""}`,
    icon: (floor.id === selectedFloorId ? "check" : "layers") as FeatherName,
    onPress: () => { void pick(floor.id); },
  }));
  const currentLabel = selected ? floorDisplayLabel(selected) : "Select floor";
  return (
    <Menu
      align={compact ? "right" : "left"}
      items={items}
      triggerLabel={`Switch workspace. Current workspace: ${currentLabel}`}
      triggerTestID="floor-switcher"
    >
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, height: 42, borderRadius: radius.lg, backgroundColor: color.surface, borderWidth: layout.hairline, borderColor: color.line }}>
        <Feather name="layers" size={15} color={color.brass} />
        {!compact ? <Text numberOfLines={1} style={{ flex: 1, fontFamily: font.medium, fontSize: 12.5, color: color.ink }}>{currentLabel}</Text> : null}
        <Feather name="chevron-down" size={14} color={color.inkSoft} />
      </View>
    </Menu>
  );
}

const FLOOR_ROUTE_SEGMENTS: Record<string, string[]> = {
  [SANITARY_FLOOR_ID]: ["quotations", "purchases", "purchase-orders", "godown-stock"],
  [TILES_FLOOR_ID]: ["tiles", "orders"],
  [KITCHEN_FLOOR_ID]: ["kitchen"],
  [FURNITURE_FLOOR_ID]: ["furniture"],
};

function isRouteCompatibleWithFloor(segments: string[], floorId: string) {
  return !Object.entries(FLOOR_ROUTE_SEGMENTS).some(([restrictedFloor, roots]) => (
    restrictedFloor !== floorId && roots.some((root) => segments.includes(root))
  ));
}

// ── Ground Floor → Tiles module nav ────────────────────────────────────────
// The tiles document builders (Selection / Quotation) are Ground-floor pages:
// their catalog search AND the floor stamped onto saved documents both follow
// the active-floor request header, so opening them from another floor first
// switches the active floor to Ground floor before navigating.
function useTilesNav() {
  const router = useRouter();
  const { staff } = useAuth();
  const hasAccess = useModuleAccess();
  const { access, selectedFloorId, selectFloor } = useFloorAccess();
  const groundAccessible = Boolean(access && (access.all_floors || access.floor_ids.includes(TILES_FLOOR_ID)));
  // Ground Floor's Tiles module is not merely *reachable* from Ground
  // Floor — it must be invisible from every other business unit. Showing
  // these while "The Sanitary Bathroom" is the active floor is what put
  // Tile Orders and Quotation Tiles in Sanitary's navigation.
  const items = groundAccessible && selectedFloorId === TILES_FLOOR_ID
    ? TILES_ITEMS.filter((item) => (
      hasAccess(item.match) && (!item.roles || Boolean(staff && item.roles.includes(staff.role)))
    ))
    : [];
  const open = (item: NavItem) => {
    if (selectedFloorId !== TILES_FLOOR_ID) {
      // Selection is published synchronously; the destination can mount under
      // the new request scope without a browser-level reload.
      void selectFloor(TILES_FLOOR_ID).catch(() => {});
    }
    router.push(item.href as any);
  };
  return { items, open };
}

/** Nav visibility = module permission AND the active business unit.
 *
 * Both filters have to be applied in the same place: `useModuleAccess` alone
 * let a Sanitary-only destination render while Ground Floor was active, which
 * is how the Quotations item ended up showing an always-empty list whose only
 * action switched the user's business unit out from under them. */
function useVisibleNav() {
  const hasAccess = useModuleAccess();
  const { staff } = useAuth();
  const { access, selectedFloorId } = useFloorAccess();
  return (items: NavItem[]) => items.filter((item) => {
    // Kitchen and Furniture are intentionally notebook-only floors. Keeping
    // generic CRM destinations in their shell would make them look like an
    // inherited dashboard instead of the two-page floor notebook.
    if (selectedFloorId === KITCHEN_FLOOR_ID || selectedFloorId === FURNITURE_FLOOR_ID) {
      return item.floors?.includes(selectedFloorId) ?? false;
    }
    if (item.roles && (!staff?.role || !item.roles.includes(staff.role))) return false;
    if (!hasAccess(item.match)) return false;
    if (!item.floors) return true;
    // While the floor is still resolving, keep the item — hiding it first and
    // showing it a frame later reads as the nav flickering on every load.
    if (!access || !selectedFloorId) return true;
    return item.floors.includes(selectedFloorId);
  });
}

// ── Desktop sidebar ─────────────────────────────────────────────────────────
function Sidebar({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  const router = useRouter();
  const segments = useSegments() as string[];
  const { staff, logout } = useAuth();
  const visible = useVisibleNav();
  const tilesNav = useTilesNav();
  const palette = usePalette();
  const isActive = (item: NavItem) => isNavActive(item, segments);

  return (
    <SafeAreaView edges={["top", "left", "bottom"]} style={styles.sidebar}>
      <View style={{ paddingHorizontal: collapsed ? space.x3 : space.x4, paddingTop: space.x5, paddingBottom: space.x4, alignItems: collapsed ? "center" : "stretch", gap: space.x3 }}>
        <Wordmark compact={collapsed} />
        <Pressable
          testID="admin-sidebar-collapse-toggle"
          accessibilityRole="button"
          accessibilityLabel={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          onPress={onToggle}
          style={[styles.sidebarToggle, collapsed && { alignSelf: "center" }]}
        >
          <Feather name={collapsed ? "chevrons-right" : "chevrons-left"} size={14} color={color.inkMid} />
          {!collapsed ? <Text style={styles.sidebarToggleLabel}>Collapse</Text> : null}
        </Pressable>
      </View>
      <View style={{ paddingHorizontal: space.x3, paddingBottom: space.x3, alignItems: collapsed ? "center" : "stretch" }}><FloorSwitcher compact={collapsed} /></View>
      <View style={{ paddingHorizontal: space.x3, paddingBottom: space.x3, alignItems: collapsed ? "center" : "stretch" }}>
        {collapsed ? (
          <Pressable accessibilityRole="button" accessibilityLabel="Search" onPress={palette.open} style={styles.railItem}>
            <Feather name="search" size={18} color={color.inkSoft} />
          </Pressable>
        ) : <SearchTrigger />}
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingHorizontal: space.x3, gap: 1, alignItems: collapsed ? "center" : "stretch" }} showsVerticalScrollIndicator={false}>
        {(["Daily work", "Records & operations", "Management"] as const).map(group => {
          const destinations = group === "Management" ? visible(SECONDARY)
            : [...visible(PRIMARY), ...tilesNav.items].filter(n => {
              const daily = ["dashboard", "walkins", "followups", "catalog", "quotations", "tiles", "kitchen", "furniture", "quotation-follow-up"].includes(n.match);
              return group === "Daily work" ? daily : !daily;
            });
          return destinations.length ? <View key={group} style={{ gap: 1, marginBottom: space.x3 }}>
            {!collapsed ? <Text style={{ fontFamily: font.semibold, fontSize: 10.5, letterSpacing: 1.05, textTransform: "uppercase", color: color.inkSoft, paddingHorizontal: space.x3, paddingVertical: space.x2 }}>{group}</Text> : null}
            {destinations.map(n => <SideItem key={n.href} item={n} active={isActive(n)} compact={collapsed}
              onPress={() => { if (tilesNav.items.includes(n)) void tilesNav.open(n); else router.push(n.href as any); }} />)}
          </View> : null;
        })}
      </ScrollView>

      <View style={{ padding: space.x3, gap: space.x3, alignItems: collapsed ? "center" : "stretch" }}>
        <Hairline />
        <Menu
          triggerLabel="Account menu"
          align="left"
          items={[{
            label: "Sign out", icon: "log-out", tone: "risk",
            onPress: async () => { await logout(); router.replace("/(auth)/login"); },
          }]}
        >
          <View style={[styles.userRow, collapsed && { justifyContent: "center" }]}>
            <Avatar name={staff?.full_name} size={32} />
            {!collapsed ? <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontFamily: font.medium, fontWeight: "500", fontSize: 13, color: color.ink }}>
                {staff?.full_name}
              </Text>
              <Text numberOfLines={1} style={{ fontFamily: font.regular, fontSize: 11.5, color: color.inkSoft }}>
                {roleLabel[staff?.role || ""] || staff?.role}
              </Text>
            </View> : null}
            {!collapsed ? <Feather name="more-horizontal" size={15} color={color.inkFaint} /> : null}
          </View>
        </Menu>
      </View>
    </SafeAreaView>
  );
}

// ── Tablet icon rail ────────────────────────────────────────────────────────
function Rail() {
  const router = useRouter();
  const segments = useSegments() as string[];
  const { staff, logout } = useAuth();
  const visible = useVisibleNav();
  const palette = usePalette();
  const tilesNav = useTilesNav();
  const isActive = (item: NavItem) => isNavActive(item, segments);

  const RailBtn = ({ item }: { item: NavItem }) => {
    const on = isActive(item);
    return (
      <Pressable
        testID={`nav-${item.match}`}
        accessibilityRole="link"
        accessibilityLabel={item.label}
        {...(Platform.OS === "web" ? { title: item.label } : {})}
        accessibilityState={{ selected: on }}
        onPress={() => router.push(item.href as any)}
        style={({ pressed, hovered }: any) => [
          styles.railItem,
          { backgroundColor: on ? color.accentTint : pressed || hovered ? color.hoverWash : "transparent" },
        ]}
      >
        <View style={[styles.brassBarRail, { backgroundColor: on ? color.brass : "transparent" }]} />
        <Feather name={item.icon} size={18} color={on ? color.action : color.inkSoft} />
      </Pressable>
    );
  };

  return (
    <SafeAreaView edges={["top", "left", "bottom"]} style={styles.rail}>
      <View style={{ alignItems: "center", paddingVertical: space.x4, gap: space.x4 }}>
        <Wordmark compact />
        <FloorSwitcher compact />
        <Pressable accessibilityRole="button" accessibilityLabel="Search" onPress={palette.open} style={styles.railItem}>
          <Feather name="search" size={18} color={color.inkSoft} />
        </Pressable>
      </View>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ alignItems: "center", gap: 2 }} showsVerticalScrollIndicator={false}>
        {visible(PRIMARY).map((n) => <RailBtn key={n.href} item={n} />)}
        {tilesNav.items.map((n) => {
          const on = n.match === "orders" ? segments.includes("orders") : segments.includes("tiles") && !segments.includes("orders");
          return (
            <Pressable
              key={n.href}
              testID={`nav-${n.match}`}
              accessibilityRole="link"
              accessibilityLabel={n.label}
              accessibilityState={{ selected: on }}
              onPress={() => { void tilesNav.open(n); }}
              style={({ pressed, hovered }: any) => [
                styles.railItem,
                { backgroundColor: on ? color.accentTint : pressed || hovered ? color.hoverWash : "transparent" },
              ]}
            >
              <View style={[styles.brassBarRail, { backgroundColor: on ? color.brass : "transparent" }]} />
              <Feather name={n.icon} size={18} color={on ? color.action : color.inkSoft} />
            </Pressable>
          );
        })}
        <View style={{ height: space.x4 }} />
        {visible(SECONDARY).map((n) => (
          <RailBtn key={n.href} item={n} />
        ))}
      </ScrollView>
      <View style={{ alignItems: "center", paddingVertical: space.x4 }}>
        <Menu
          triggerLabel="Account menu"
          align="left"
          items={[{
            label: "Sign out", icon: "log-out", tone: "risk",
            onPress: async () => { await logout(); router.replace("/(auth)/login"); },
          }]}
        >
          <Avatar name={staff?.full_name} size={32} />
        </Menu>
      </View>
    </SafeAreaView>
  );
}

// ── Phone bottom bar + More sheet ───────────────────────────────────────────
function PhoneBar() {
  const router = useRouter();
  const segments = useSegments() as string[];
  const { staff, logout } = useAuth();
  const visible = useVisibleNav();
  const palette = usePalette();
  const tilesNav = useTilesNav();
  const { access, selectedFloorId, loading: floorLoading } = useFloorAccess();
  const { loading: permissionsLoading } = usePermissionMatrix();
  const [moreOpen, setMoreOpen] = useState(false);
  const shellReady = Boolean(staff && access && selectedFloorId && !floorLoading && !permissionsLoading);
  if (!shellReady) return <PhoneBarSkeleton />;
  const all = [...visible(PRIMARY), ...tilesNav.items, ...visible(SECONDARY)];
  const notebook = selectedFloorId === KITCHEN_FLOOR_ID || selectedFloorId === FURNITURE_FLOOR_ID;
  const priorities = notebook ? all.filter(item => item.href.includes('/notebook/'))
    : ['dashboard', 'catalog', selectedFloorId === TILES_FLOOR_ID ? 'tiles' : 'quotations', 'followups']
      .flatMap(match => all.filter(item => item.match === match));
  const more = all.filter(item => !priorities.some(tab => tab.href === item.href));
  const isActive = (item: NavItem) => item.match === 'tiles'
    ? segments.includes('tiles') && !segments.includes('orders') : isNavActive(item, segments);
  const moreActive = more.some(isActive);
  return <>
    <View role="navigation" accessibilityLabel="Primary" style={styles.phoneBar}>
      {priorities.map(item => <Pressable key={item.href} testID={`bottom-nav-${item.match}`}
        accessibilityRole="link" accessibilityLabel={item.label} accessibilityState={{ selected: isActive(item) }}
        onPress={() => router.push(item.href as any)} style={styles.tab}>
        <View style={[styles.tabIconWrap, isActive(item) && styles.tabIconWrapActive]}>
          <Feather name={item.icon} size={20} color={isActive(item) ? color.action : color.inkMid} />
        </View>
        <Text numberOfLines={2} style={[styles.tabLabel, isActive(item) && styles.tabLabelActive]}>
          {notebook ? item.href.includes('quotation-follow-up') ? 'Quotation follow-up' : 'Walk-ins' : item.label}
        </Text>
      </Pressable>)}
      <Pressable testID={notebook ? "bottom-nav-notebook-workspace" : "bottom-nav-more"}
        accessibilityRole="button" accessibilityLabel="More" accessibilityState={{ expanded: moreOpen, selected: moreActive }}
        onPress={() => setMoreOpen(true)} style={styles.tab}>
        <View style={[styles.tabIconWrap, moreActive && styles.tabIconWrapActive]}><Feather name="menu" size={20} color={moreActive ? color.action : color.inkMid} /></View>
        <Text style={[styles.tabLabel, moreActive && styles.tabLabelActive]}>More</Text>
      </Pressable>
    </View>
    <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="Workspace">
      {!notebook ? <Pressable accessibilityRole="button" accessibilityLabel="Search everything"
        onPress={() => { setMoreOpen(false); setTimeout(palette.open, 200); }} style={styles.moreRow}>
        <Feather name="search" size={18} color={color.inkMid} /><Text style={styles.moreLabel}>Search everything</Text>
      </Pressable> : null}
      {more.map(item => <Pressable key={item.href} accessibilityRole="link" accessibilityLabel={item.label}
        {...(Platform.OS === "web" ? { title: item.label } : {})}
        onPress={() => { setMoreOpen(false); router.push(item.href as any); }} style={styles.moreRow}>
        <Feather name={item.icon} size={18} color={color.inkMid} /><Text style={styles.moreLabel}>{item.label}</Text>
      </Pressable>)}
      <Hairline />
      <View style={[styles.moreRow, { height: 'auto', minHeight: 56 }]}><Avatar name={staff?.full_name} />
        <View style={{ flex: 1 }}><Text style={styles.moreLabel}>{staff?.full_name}</Text><Text style={{ color: color.inkMid }}>{roleLabel[staff?.role || '']}</Text></View>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Sign out" style={styles.moreRow}
        onPress={async () => { setMoreOpen(false); await logout(); router.replace('/(auth)/login'); }}>
        <Feather name="log-out" size={18} color={color.risk} /><Text style={[styles.moreLabel, { color: color.risk }]}>Sign out</Text>
      </Pressable>
    </Sheet>
  </>;
}

function PhoneBarSkeleton() {
  return (
    <View testID="bottom-nav-loading" accessibilityLabel="Loading navigation" accessibilityLiveRegion="polite" style={styles.phoneBar}>
      {[0, 1, 2, 3, 4].map((slot) => (
        <View key={slot} style={slot === 2 ? styles.navLoadingFabSlot : styles.navLoadingSlot}>
          <View style={[styles.navLoadingIcon, slot === 2 && styles.navLoadingFab]} />
          {slot !== 2 ? <View style={styles.navLoadingLabel} /> : null}
        </View>
      ))}
    </View>
  );
}

// ── Layout root ─────────────────────────────────────────────────────────────
function FloorAccessGate({ children }: { children: React.ReactNode }) {
  const { access, floors, selectedFloorId, loading, error, retry } = useFloorAccess();
  const { logout } = useAuth();
  const router = useRouter();

  // Never mount business screens before a concrete, server-authorized floor
  // is known. Besides making loading/error states explicit, this closes the
  // brief window where an inherited local-storage selection could be sent as
  // an X-Floor-Id for a different staff account.
  if (loading) {
    return <View testID="floor-access-loading" accessibilityLiveRegion="polite" style={styles.floorAccessState}>
      <ActivityIndicator color={color.brass} />
      <Text style={styles.floorAccessTitle}>Loading your workspace…</Text>
      <Text style={styles.floorAccessCopy}>Checking the floors assigned to your account.</Text>
    </View>;
  }
  if (error) {
    return <View testID="floor-access-error" accessibilityLiveRegion="assertive" style={styles.floorAccessState}>
      <Feather name="wifi-off" size={28} color={color.risk} />
      <Text style={styles.floorAccessTitle}>Workspace access unavailable</Text>
      <Text style={styles.floorAccessCopy}>{error}</Text>
      <Pressable testID="floor-access-retry" accessibilityRole="button" accessibilityLabel="Retry loading workspace access" onPress={() => { void retry(); }} style={styles.floorAccessButton}>
        <Text style={styles.floorAccessButtonText}>Try again</Text>
      </Pressable>
    </View>;
  }
  if (!access || floors.length === 0 || !selectedFloorId) {
    return <View testID="floor-access-empty" accessibilityLiveRegion="assertive" style={styles.floorAccessState}>
      <Feather name="lock" size={28} color={color.inkSoft} />
      <Text style={styles.floorAccessTitle}>No floor access assigned</Text>
      <Text style={styles.floorAccessCopy}>Your account has no workspace assigned. Ask an owner or manager to assign a floor, then sign in again.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={async () => { await logout(); router.replace("/(auth)/login"); }} style={styles.floorAccessButton}>
        <Text style={styles.floorAccessButtonText}>Sign out</Text>
      </Pressable>
    </View>;
  }
  return <>{children}</>;
}

function CustomAccessRouteGate({ children }: { children: React.ReactNode }) {
  const { staff } = useAuth();
  const hasAccess = useModuleAccess();
  const segments = useSegments() as string[];
  const router = useRouter();
  const module = segments.includes("payments") ? "payments"
    : segments.includes("quotations") ? "quotations"
    : segments.includes("catalog") ? "catalog"
    : segments.includes("customers") ? "customers"
    : segments.includes("purchases") || segments.includes("purchases-completed") || segments.includes("purchase-orders") ? "purchases"
    : segments.includes("godown-stock") ? "godown-stock"
    : segments.includes("followups") ? "followups"
    : segments.includes("notifications") ? "notifications"
    : segments.includes("walkins") ? "walkins"
    : segments.includes("orders") ? "orders"
    : segments.includes("dashboard") ? "dashboard"
    : null;

  useEffect(() => {
    if (staff?.custom_access && module && !hasAccess(module)) {
      router.replace(staffLandingPath(staff.access_profile, staff.access_grants) as any);
    }
  }, [staff, module, hasAccess, router]);

  if (staff?.custom_access && module && !hasAccess(module)) return null;
  return <>{children}</>;
}

export default function AdminLayout() {
  const { isPhone, isTablet } = useBp();
  const builderSegments = useSegments() as string[];
  const focusedQuotation = builderSegments.includes("quotations") && builderSegments.includes("new");
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {
    void storage.getItem<boolean>("forge.admin.sidebar.collapsed.v1", false).then((value) => {
      setSidebarCollapsed(value === true);
    });
  }, []);

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current;
      void storage.setItem("forge.admin.sidebar.collapsed.v1", next);
      return next;
    });
  };

  if (isPhone) {
    return (
      <PaletteProvider>
        <AppScaffold
          testID="admin-mobile-shell"
          style={{ backgroundColor: color.canvas }}
          bottomNavigation={focusedQuotation ? null : <PhoneBar />}
        >
          <ConnectionStatus /><FloorAccessGate><CustomAccessRouteGate>{isPhone && !focusedQuotation ? <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}><FloorSwitcher /></View> : null}<Slot /></CustomAccessRouteGate></FloorAccessGate>
        </AppScaffold>
      </PaletteProvider>
    );
  }

  return (
    <PaletteProvider>
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: color.canvas }}>
        <View role="navigation" accessibilityLabel="Primary" style={{
          width: isTablet ? layout.rail : sidebarCollapsed ? layout.rail : layout.sidebar,
          borderRightWidth: layout.hairline, borderRightColor: color.line,
          ...(Platform.OS === "web" ? ({ transition: "width 200ms cubic-bezier(0.2, 0, 0, 1)" } as any) : {}),
        }}>
          {isTablet ? <Rail /> : <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />}
        </View>
        <View role="main" accessibilityLabel="Workspace content" style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <ConnectionStatus /><FloorAccessGate><CustomAccessRouteGate>{isPhone && !focusedQuotation ? <View style={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}><FloorSwitcher /></View> : null}<Slot /></CustomAccessRouteGate></FloorAccessGate>
        </View>
      </View>
    </PaletteProvider>
  );
}

const styles = StyleSheet.create({
  floorAccessState: { flex: 1, alignItems: "center", justifyContent: "center", padding: space.x6, gap: space.x3, backgroundColor: color.canvas },
  floorAccessTitle: { fontFamily: font.semibold, fontWeight: "600", fontSize: 17, color: color.ink, textAlign: "center" },
  floorAccessCopy: { fontFamily: font.regular, fontSize: 13, lineHeight: 19, color: color.inkSoft, textAlign: "center", maxWidth: 360 },
  floorAccessButton: { minHeight: 44, paddingHorizontal: space.x4, borderRadius: radius.md, alignItems: "center", justifyContent: "center", backgroundColor: color.ink, marginTop: space.x1 },
  floorAccessButtonText: { fontFamily: font.medium, fontWeight: "500", fontSize: 13, color: color.onAction },
  sidebar: { flex: 1, backgroundColor: color.surface },
  rail: { flex: 1, backgroundColor: color.surface },
  monogram: {
    width: 26, height: 26, borderRadius: 7, backgroundColor: color.ink,
    alignItems: "center", justifyContent: "center",
  },
  searchTrigger: {
    flexDirection: "row", alignItems: "center", gap: 8,
    height: 34, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: 10,
  },
  sideItem: {
    flexDirection: "row", alignItems: "center", gap: 10,
    height: 36, borderRadius: radius.sm, paddingLeft: 10, paddingRight: 10,
    overflow: "hidden",
  },
  sideItemCompact: {
    width: 42, justifyContent: "center", paddingLeft: 0, paddingRight: 0,
  },
  sidebarToggle: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    minHeight: 30, borderRadius: radius.sm, paddingHorizontal: 8,
    backgroundColor: color.sunken,
  },
  sidebarToggleLabel: { fontFamily: font.medium, fontSize: 11.5, color: color.inkMid },
  brassBar: {
    position: "absolute", left: 0, top: 8, bottom: 8, width: 2.5, borderRadius: 2,
  },
  brassBarRail: {
    position: "absolute", left: 0, top: 10, bottom: 10, width: 3, borderRadius: 3,
  },
  railItem: {
    width: 44, height: 44, borderRadius: radius.md,
    alignItems: "center", justifyContent: "center", overflow: "hidden",
  },
  userRow: {
    flexDirection: "row", alignItems: "center", gap: 10,
    paddingHorizontal: 8, paddingVertical: 6, borderRadius: radius.md,
  },
  phoneBar: {
    height: layout.bottomBar, flexDirection: "row", alignItems: "center",
    paddingHorizontal: space.x2,
  },
  notebookPhoneBar: {
    minHeight: layout.bottomBar, flexDirection: "row", alignItems: "center",
    paddingHorizontal: space.x3, gap: space.x2,
  },
  notebookWorkspaceTab: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 6, gap: 3 },
  tab: { flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 6, gap: 3 },
  tabIconWrap: {
    width: 40, height: 26, borderRadius: radius.md, alignItems: "center", justifyContent: "center",
  },
  tabIconWrapActive: { backgroundColor: color.brassTint },
  tabLabel: { fontFamily: font.medium, fontWeight: "500", fontSize: 10.5, textAlign: "center", color: color.inkMid, letterSpacing: 0.1 },
  tabLabelActive: { color: color.ink, fontWeight: "600" },
  fabSlot: { width: 68, alignItems: "center", justifyContent: "center", paddingTop: 4 },
  fab: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: color.brass,
    alignItems: "center", justifyContent: "center", marginTop: -22,
    borderWidth: 4, borderColor: color.canvas,
  },
  actionLabel: { marginTop: -2, fontFamily: font.medium, fontSize: 10.5, textAlign: "center", color: color.inkMid },
  navLoadingSlot: { flex: 1, alignItems: "center", justifyContent: "center", gap: 6 },
  navLoadingFabSlot: { width: 68, alignItems: "center", justifyContent: "center" },
  navLoadingIcon: { width: 20, height: 20, borderRadius: 10, backgroundColor: color.sunken },
  navLoadingFab: { width: 44, height: 44, borderRadius: 22, marginTop: -16 },
  navLoadingLabel: { width: 26, height: 7, borderRadius: 4, backgroundColor: color.sunken },
  moreRow: {
    flexDirection: "row", alignItems: "center", gap: 12,
    height: 48, paddingHorizontal: 4,
  },
  moreLabel: { fontFamily: font.medium, fontWeight: "500", fontSize: 14.5, color: color.ink },
});
