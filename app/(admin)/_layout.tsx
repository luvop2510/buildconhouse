import { ConnectionStatus } from "@/src/design/ConnectionStatus";
import { PRIMARY, SECONDARY, TILES_ITEMS, type NavItem } from "@/src/design/navigation";
// ─────────────────────────────────────────────────────────────────────────────
// BuildCon House · Shell.
// Tablet and desktop: collapsible labelled sidebar. Phone: bottom bar.
// One brass bar marks where you are. The command palette lives here (⌘K).
// ─────────────────────────────────────────────────────────────────────────────
import Feather from "@expo/vector-icons/Feather";
import { Slot, useRouter, useSegments, useLocalSearchParams, usePathname } from "expo-router";
import React, { useEffect, useState } from "react";
import { ActivityIndicator, Platform, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import {
  Avatar, FeatherName, Hairline, KeyCap, Menu, Sheet, usePalette,
} from "@/src/design/components";
import { PaletteProvider } from "@/src/design/CommandPalette";
import { useBp } from "@/src/design/responsive";
import { color, font, layout, radius, space } from "@/src/design/tokens";
import { NavigationLink } from "@/src/design/NavigationLink";
import { BuildConLogo } from "@/src/design/BrandLogo";
import { useInitialAccountRoute } from "@/src/state/initial-account-route";
import { useAuth } from "@/src/state/auth";
import { useModuleAccess, usePermissionMatrix } from "@/src/hooks/use-permissions";
import { staffLandingPath } from "@/src/access-profiles";
import { hasRouteDestination, isCustomerEditorRoute, isPersonalAccountRoute, moduleForRoute, resolveFloorRouteSegments } from "@/src/team-delegation";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { AppScaffold } from "@/src/components/mobile/AppScaffold";
import { useInputActive } from "@/src/hooks/use-input-active";
import { WorkspacePageBoundary } from "@/src/components/PageErrorBoundary";
import { storage } from "@/src/utils/storage";
import { FURNITURE_FLOOR_ID, KITCHEN_FLOOR_ID, SANITARY_FLOOR_ID, TILES_FLOOR_ID, floorDisplayLabel, floorLandingPath } from "@/src/constants/floors";

function useResolvedFloorSegments(): string[] {
  const segments = useSegments() as string[];
  const { floor, stage } = useLocalSearchParams<{ floor?: string; stage?: string }>();
  const pathname = usePathname();
  const activeStage = pathname.match(/^\/kitchen\/(?:[^/]+\/)?stages\/([^/]+)$/)?.[1] || stage;
  return resolveFloorRouteSegments(segments, floor).map(part => part === "[stage]" && activeStage ? activeStage : part);
}

// A web link needs an actual href for native Enter activation. Keep the
// existing callback as the navigation owner (including floor synchronization).
function WorkspaceLink({ href, onPress, ...props }: Omit<React.ComponentProps<typeof Pressable>, "onPress"> & { href: string; onPress: () => void }) {
  return <NavigationLink href={href as any} {...props} onPress={(event) => {
      const mouse = event.nativeEvent as any;
      if (Platform.OS === "web" && (mouse.metaKey || mouse.ctrlKey || mouse.shiftKey || mouse.altKey || mouse.button > 0)) return;
      event.preventDefault();
      onPress();
    }} />;
}

function isNavActive(item: NavItem, segments: string[]): boolean {
  if (item.match.startsWith("kitchen-") && segments.includes("kitchen") && !segments.includes("notebook")) {
    const stageIndex = segments.indexOf("stages");
    return stageIndex >= 0 && item.match === `kitchen-${segments[stageIndex + 1]}`;
  }
  if (item.match === "tiles") return segments.includes("tiles") && !segments.includes("orders");
  if (item.match === "purchases") return segments.includes("purchases") || segments.includes("purchases-completed");
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
    <WorkspaceLink
      href={item.href}
      testID={`nav-${item.match}`}
      onPress={onPress}
      accessibilityRole="link"
      accessibilityLabel={item.label}
        {...(Platform.OS === "web" ? { title: item.label } : {})}
      accessibilityState={{ selected: active }}
      aria-current={active ? "page" : undefined}
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
    </WorkspaceLink>
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
  const { staff } = useAuth();
  const router = useRouter();
  const segments = useResolvedFloorSegments();
  const selected = floors.find((floor) => floor.id === selectedFloorId);
  // Keep the active workspace selector visible in the shell. Hiding it for a
  // single assigned floor made restricted accounts look as if floor access
  // was unavailable, and hid the current data scope from every page.
  if (!access || floors.length === 0) return null;
  const pick = (id: string) => {
    if (id === selectedFloorId) return;

    // The hook publishes synchronously; persistence happens in the
    // background. Mounted screens that consume the hook update immediately,
    // while the route only changes when the current screen belongs to the
    // floor we are leaving.
    void selectFloor(id).catch(() => {});
    if (staff?.custom_access) {
      router.replace(staffLandingPath(null, staff.access_grants || [], id) as any);
    } else if (!isRouteCompatibleWithFloor(segments, id) ||
      (!isSharedFloorRoute(segments) && (
        (id === KITCHEN_FLOOR_ID && !segments.includes("kitchen")) ||
        (id === FURNITURE_FLOOR_ID && !segments.includes("furniture"))
      ))) {
      // Keep shared business pages, including the regular walk-in register,
      // mounted when the workspace changes. Department-only pages still
      // navigate to the destination floor's workspace.
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
  [SANITARY_FLOOR_ID]: ["quotations", "godown-stock", "purchases", "purchases-completed", "purchase-orders"],
  [TILES_FLOOR_ID]: ["tiles", "orders"],
  [KITCHEN_FLOOR_ID]: ["kitchen"],
  [FURNITURE_FLOOR_ID]: ["furniture", "furniture-quotations"],
};

const SHARED_FLOOR_ROUTES = ["catalog", "customers", "payments", "payments-list", "walkins", "followups", "settings", "team", "notifications", "sales-data"];

function isSharedFloorRoute(segments: string[]) {
  return SHARED_FLOOR_ROUTES.some(segment => segments.includes(segment));
}

function isRouteCompatibleWithFloor(segments: string[], floorId: string) {
  if (floorId === KITCHEN_FLOOR_ID && !segments.includes("kitchen") && !isPersonalAccountRoute(segments) && !isCustomerEditorRoute(segments)) return false;
  if (segments.includes("catalog") && ![SANITARY_FLOOR_ID, TILES_FLOOR_ID].includes(floorId)) return false;
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
      hasAccess(item.match) && (staff?.custom_access || !item.roles || Boolean(staff && item.roles.includes(staff.role)))
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
    if (selectedFloorId === KITCHEN_FLOOR_ID && !item.match.startsWith("kitchen-")) return false;
    const permission = item.match.startsWith("kitchen-") ? "kitchen-projects" : item.match;
    if (item.floors && selectedFloorId && !item.floors.includes(selectedFloorId)) return false;
    if (staff?.custom_access) return hasAccess(permission);
    // These units share floor-scoped business pages alongside their notebooks.
    if (selectedFloorId === KITCHEN_FLOOR_ID || selectedFloorId === FURNITURE_FLOOR_ID) {
      const shared = SHARED_FLOOR_ROUTES.includes(item.match);
      return (shared || Boolean(item.floors?.includes(selectedFloorId))) && hasAccess(permission);
    }
    if (item.roles && (!staff?.role || !item.roles.includes(staff.role))) return false;
    if (!hasAccess(permission)) return false;
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
  const segments = useResolvedFloorSegments();
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
          accessibilityState={{ expanded: !collapsed }}
          aria-expanded={!collapsed}
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
        {(["Kitchen", "Daily work", "Records & operations", "Management"] as const).map(group => {
          const destinations = group === "Management" ? visible(SECONDARY)
            : [...visible(PRIMARY), ...tilesNav.items].filter(n => {
              if (group === "Kitchen") return n.match.startsWith("kitchen-");
              if (n.match.startsWith("kitchen-")) return false;
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
          items={[{ label: "My account", icon: "user", onPress: () => router.push("/(admin)/settings") }, {
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

// ── Phone bottom bar + More sheet ───────────────────────────────────────────
function PhoneBar() {
  const router = useRouter();
  const segments = useResolvedFloorSegments();
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
  const priorities = selectedFloorId === KITCHEN_FLOOR_ID ? all.filter(item => item.match.startsWith('kitchen-')).slice(0, 3)
    : notebook ? all.filter(item => item.match === 'walkins' || item.match === 'followups' || item.href.includes('/notebook/'))
    : ['dashboard', 'catalog', selectedFloorId === TILES_FLOOR_ID ? 'tiles' : 'quotations', 'followups']
      .flatMap(match => all.filter(item => item.match === match));
  const more = all.filter(item => !priorities.some(tab => tab.href === item.href));
  const isActive = (item: NavItem) => item.match === 'tiles'
    ? segments.includes('tiles') && !segments.includes('orders') : isNavActive(item, segments);
  const moreActive = more.some(isActive);
  return <>
    <View role="navigation" accessibilityLabel="Primary" style={styles.phoneBar}>
      {priorities.map(item => <WorkspaceLink href={item.href} key={item.href} testID={`bottom-nav-${item.match}`}
        accessibilityRole="link" accessibilityLabel={item.label} accessibilityState={{ selected: isActive(item) }}
        aria-current={isActive(item) ? "page" : undefined}
        onPress={() => router.push(item.href as any)} style={styles.tab}>
        <View style={[styles.tabIconWrap, isActive(item) && styles.tabIconWrapActive]}>
          <Feather name={item.icon} size={20} color={isActive(item) ? color.action : color.inkMid} />
        </View>
        <Text numberOfLines={2} style={[styles.tabLabel, isActive(item) && styles.tabLabelActive]}>
          {item.match === 'kitchen' ? 'Kitchen leads' : item.match === 'furniture' ? 'Furniture leads' : item.label}
        </Text>
      </WorkspaceLink>)}
      <Pressable testID={notebook ? "bottom-nav-notebook-workspace" : "bottom-nav-more"}
        accessibilityRole="button" accessibilityLabel={selectedFloorId === KITCHEN_FLOOR_ID ? "All stages" : "More"} accessibilityState={{ expanded: moreOpen, selected: moreActive }}
        aria-expanded={moreOpen}
        onPress={() => setMoreOpen(true)} style={styles.tab}>
        <View style={[styles.tabIconWrap, moreActive && styles.tabIconWrapActive]}><Feather name="menu" size={20} color={moreActive ? color.action : color.inkMid} /></View>
        <Text style={[styles.tabLabel, moreActive && styles.tabLabelActive]}>{selectedFloorId === KITCHEN_FLOOR_ID ? "All stages" : "More"}</Text>
      </Pressable>
    </View>
    <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={selectedFloorId === KITCHEN_FLOOR_ID ? "Kitchen stages" : "Workspace"}>
      {!notebook ? <Pressable accessibilityRole="button" accessibilityLabel="Search everything"
        onPress={() => { setMoreOpen(false); setTimeout(palette.open, 200); }} style={styles.moreRow}>
        <Feather name="search" size={18} color={color.inkMid} /><Text style={styles.moreLabel}>Search everything</Text>
      </Pressable> : null}
      {more.map(item => <WorkspaceLink href={item.href} key={item.href} accessibilityRole="link" accessibilityLabel={item.label}
        {...(Platform.OS === "web" ? { title: item.label } : {})}
        onPress={() => { setMoreOpen(false); router.push(item.href as any); }} style={styles.moreRow}>
        <Feather name={item.icon} size={18} color={color.inkMid} /><Text style={styles.moreLabel}>{item.label}</Text>
      </WorkspaceLink>)}
      <Hairline />
      <View style={[styles.moreRow, { height: 'auto', minHeight: 56 }]}><Avatar name={staff?.full_name} />
        <View style={{ flex: 1 }}><Text style={styles.moreLabel}>{staff?.full_name}</Text><Text style={{ color: color.inkMid }}>{roleLabel[staff?.role || '']}</Text></View>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="My account" style={styles.moreRow}
        onPress={() => { setMoreOpen(false); router.push('/(admin)/settings'); }}>
        <Feather name="user" size={18} color={color.inkMid} /><Text style={styles.moreLabel}>My account</Text>
      </Pressable>
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
  const { staff, loading: authLoading, logout } = useAuth();
  const segments = useResolvedFloorSegments();
  const router = useRouter();

  const initialAccount = useInitialAccountRoute();
  const destinationReady = hasRouteDestination(segments);
  const initialPersonal = initialAccount.path && isPersonalAccountRoute(initialAccount.path.split('?')[0].split('/').filter(Boolean));
  const pendingAccount = !destinationReady && initialPersonal;
  useEffect(() => {
    if (authLoading || !staff || !initialAccount.path) return;
    if (!initialPersonal && (!access || !selectedFloorId || loading)) return;
    // Withholding Slot until floor access resolves lets Expo temporarily
    // normalize a cold business deep link to the default /access child.
    // Retain the requested URL through that loading window without mounting
    // its business reads before an authorized workspace is ready.
    if (destinationReady && !segments.includes("access")) initialAccount.finish();
    else if (initialPersonal || (access && selectedFloorId && !loading)) {
      if (initialAccount.path.split('?')[0] === "/access" && segments.includes("access")) initialAccount.finish();
      else router.replace(`/(admin)${initialAccount.path}` as any);
    }
  }, [authLoading, staff, destinationReady, initialAccount, initialPersonal, access, selectedFloorId, loading, segments, router]);

  useEffect(() => {
    if (authLoading || !staff || staff.custom_access || !access || !selectedFloorId || !destinationReady || !segments.includes("dashboard")) return;
    const kitchenOrFurniture = selectedFloorId === KITCHEN_FLOOR_ID || selectedFloorId === FURNITURE_FLOOR_ID;
    if (!kitchenOrFurniture) return;
    // Only choose a department default for the generic dashboard. A bookmarked
    // floor-specific page owns its floor synchronization; replacing it here
    // races that hook and loses the user's destination during hydration.
    router.replace(`/(admin)${floorLandingPath(selectedFloorId)}` as any);
  }, [authLoading, staff, access, selectedFloorId, destinationReady, segments, router]);

  const retiredWorkspaceRoute = Boolean(selectedFloorId && (
    (selectedFloorId === KITCHEN_FLOOR_ID && destinationReady && !segments.includes("kitchen") && !isPersonalAccountRoute(segments) && !isCustomerEditorRoute(segments)) ||
    (["purchases", "purchases-completed", "purchase-orders"].some(part => segments.includes(part)) && selectedFloorId !== SANITARY_FLOOR_ID) ||
    (segments.includes("catalog") && ![SANITARY_FLOOR_ID, TILES_FLOOR_ID].includes(selectedFloorId))
  ));
  useEffect(() => {
    if (retiredWorkspaceRoute) router.replace(`/(admin)${floorLandingPath(selectedFloorId)}` as any);
  }, [retiredWorkspaceRoute, router, selectedFloorId]);

  // Password, MFA and session management belong to the authenticated account,
  // even when every business floor has been switched off. Business routes
  // still require a concrete server-authorized floor below.
  if (!authLoading && staff && (isPersonalAccountRoute(segments) || pendingAccount)) return <>{children}</>;

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
      <Text style={styles.floorAccessCopy}>Your account has no workspace assigned. Ask an owner to assign a floor, then sign in again.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Sign out" onPress={async () => { await logout(); router.replace("/(auth)/login"); }} style={styles.floorAccessButton}>
        <Text style={styles.floorAccessButtonText}>Sign out</Text>
      </Pressable>
    </View>;
  }
  if (retiredWorkspaceRoute) return null;
  return <>{children}</>;
}

function CustomAccessRouteGate({ children }: { children: React.ReactNode }) {
  const { staff } = useAuth();
  const hasAccess = useModuleAccess();
  const segments = useResolvedFloorSegments();
  const router = useRouter();
  const { selectedFloorId } = useFloorAccess();
  const destinationReady = hasRouteDestination(segments);
  const module = moduleForRoute(segments);

  useEffect(() => {
    // Expo can publish ['(admin)'] before a deep link's page segment. Do not
    // turn that layout-only snapshot into a denial and lose the destination.
    if (!destinationReady) return;
    if (staff?.custom_access && module && !hasAccess(module)) {
      router.replace(staffLandingPath(null, staff.access_grants || [], selectedFloorId) as any);
    }
  }, [staff, module, destinationReady, hasAccess, router, selectedFloorId]);

  if (destinationReady && staff?.custom_access && module && !hasAccess(module)) return null;
  return <>{children}</>;
}

// The navigator must stay mounted when its page fails. Wrapping Slot itself
// removes the active route and lets Expo redirect to the default child.
// Slot forwards this React Navigation option to useNavigationBuilder; Expo's
// narrower Slot type currently omits it.
const pageScreenLayout = ({ children }: { children: React.ReactNode }) => <WorkspacePageBoundary>{children}</WorkspacePageBoundary>;

export default function AdminLayout() {
  const { isPhone } = useBp();
  const inputActive = useInputActive();
  const builderSegments = useResolvedFloorSegments();
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

  // Keep the route's ancestor types and key stable when a phone rotates past
  // the sidebar breakpoint. Replacing this tree used to unmount every form,
  // including its selected photo, before the user could save it.
  return (
    <PaletteProvider>
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: color.canvas }}>
        {!isPhone ? <View key="sidebar" role="navigation" accessibilityLabel="Primary" style={{
          width: sidebarCollapsed ? layout.rail : layout.sidebar,
          borderRightWidth: layout.hairline, borderRightColor: color.line,
          ...(Platform.OS === "web" ? ({ transition: "width 200ms cubic-bezier(0.2, 0, 0, 1)" } as any) : {}),
        }}>
          <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />
        </View> : null}
        <AppScaffold
          key="workspace"
          testID={isPhone ? "admin-mobile-shell" : "admin-desktop-shell"}
          phoneSafeArea={isPhone}
          style={{ backgroundColor: color.canvas, minHeight: 0 }}
          bottomNavigation={isPhone && !focusedQuotation && !inputActive ? <PhoneBar /> : null}
        >
          <ConnectionStatus /><FloorAccessGate><CustomAccessRouteGate>{isPhone && !focusedQuotation && !inputActive ? <View testID="mobile-workspace-header" style={{ flexShrink: 0, paddingHorizontal: 16, paddingTop: 8, paddingBottom: 4 }}><FloorSwitcher /></View> : null}<Slot {...({ screenLayout: pageScreenLayout } as React.ComponentProps<typeof Slot>)} /></CustomAccessRouteGate></FloorAccessGate>
        </AppScaffold>
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
    height: 44, borderRadius: radius.md, borderWidth: 1, paddingHorizontal: 10,
  },
  sideItem: {
    flexDirection: "row", alignItems: "center", gap: 10,
    height: 44, borderRadius: radius.sm, paddingLeft: 10, paddingRight: 10,
    overflow: "hidden",
  },
  sideItemCompact: {
    width: 44, justifyContent: "center", paddingLeft: 0, paddingRight: 0,
  },
  sidebarToggle: {
    flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6,
    minHeight: 44, minWidth: 44, borderRadius: radius.sm, paddingHorizontal: 8,
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
  tab: { flex: 1, minWidth: 0, minHeight: 44, alignItems: "center", justifyContent: "center", paddingVertical: 6, gap: 3 },
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
    minHeight: 48, paddingVertical: 10, paddingHorizontal: 4,
  },
  moreLabel: { flexShrink: 1, fontFamily: font.medium, fontWeight: "500", fontSize: 14.5, color: color.ink },
});
