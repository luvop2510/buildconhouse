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

type NavItem = {
  href: string; label: string; icon: FeatherName; match: string; roles?: string[];
  // Business units this destination exists in. Omitted = every unit.
  // A single-unit module must be invisible from the others, not merely
  // reachable-but-empty: the Quotation Builder is pinned to Sanitary
  // Bathroom (every request it makes passes floorId: "first-floor"), so on
  // Ground Floor the Quotations item listed nothing and its "New Quotation"
  // button silently moved the user to the other business unit. Tile Orders /
  // Quotation Tiles are the mirror image and are already handled this way by
  // `useTilesNav`.
  //
  // Purchases is the same shape: the supplier-PO workflow belongs to Sanitary
  // Bathroom, and Ground Floor runs its stock through Tile Orders instead, so
  // the item is restricted rather than left showing an empty tracker.
  floors?: string[];
};

const PRIMARY: NavItem[] = [
  { href: "/(admin)/dashboard", label: "Today", icon: "sunrise", match: "dashboard" },
  { href: "/(admin)/walkins", label: "Walk-ins", icon: "user-plus", match: "walkins" },
  { href: "/(admin)/quotations", label: "Quotations", icon: "file-text", match: "quotations", floors: [SANITARY_FLOOR_ID] },
  { href: "/(admin)/catalog", label: "Catalog", icon: "package", match: "catalog" },
  { href: "/(admin)/customers", label: "Customers", icon: "users", match: "customers" },
  { href: "/(admin)/purchases", label: "Purchases", icon: "shopping-cart", match: "purchases", floors: [SANITARY_FLOOR_ID] },
  { href: "/(admin)/payments", label: "Payments", icon: "credit-card", match: "payments" },
  { href: "/(admin)/payments-list", label: "Payment List", icon: "list", match: "payments-list" },
  { href: "/(admin)/followups", label: "Follow-ups", icon: "phone-call", match: "followups" },
  { href: "/(admin)/notebook/kitchen", label: "Kitchen Walk-ins", icon: "user-plus", match: "kitchen", floors: [KITCHEN_FLOOR_ID] },
  { href: "/(admin)/notebook/kitchen/quotation-follow-up", label: "Quotation Follow-up", icon: "file-text", match: "quotation-follow-up", floors: [KITCHEN_FLOOR_ID] },
  { href: "/(admin)/notebook/furniture", label: "Furniture Walk-ins", icon: "user-plus", match: "furniture", floors: [FURNITURE_FLOOR_ID] },
  { href: "/(admin)/notebook/furniture/quotation-follow-up", label: "Quotation Follow-up", icon: "file-text", match: "quotation-follow-up", floors: [FURNITURE_FLOOR_ID] },
];

const SECONDARY: NavItem[] = [
  { href: "/(admin)/notifications", label: "Notifications", icon: "bell", match: "notifications" },
  { href: "/(admin)/sales-data", label: "Sales Data", icon: "trending-up", match: "sales-data" },
  { href: "/(admin)/team", label: "Team", icon: "user-check", match: "team", roles: ["owner", "admin", "manager"] },
  { href: "/(admin)/settings", label: "Settings", icon: "settings", match: "settings" },
];

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
      accessibilityState={{ selected: active }}
      style={({ pressed, hovered }: any) => [
        styles.sideItem,
        compact && styles.sideItemCompact,
        { backgroundColor: active ? color.sunken : pressed || hovered ? color.hoverWash : "transparent" },
        Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
      ]}
    >
      <View style={[styles.brassBar, { backgroundColor: active ? color.brass : "transparent" }]} />
      <Feather name={item.icon} size={16} color={active ? color.ink : color.inkSoft} />
      {!compact ? <Text
        style={{
          fontFamily: active ? font.semibold : font.medium,
          fontWeight: active ? "600" : "500",
          fontSize: 13.5, letterSpacing: -0.1,
          color: active ? color.ink : color.inkMid,
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
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 10, height: 40, borderRadius: radius.md, backgroundColor: color.surface, borderWidth: layout.hairline, borderColor: color.line }}>
        <Feather name="layers" size={15} color={color.brass} />
        {!compact ? <Text numberOfLines={1} style={{ flex: 1, fontFamily: font.medium, fontSize: 12.5, color: color.ink }}>{currentLabel}</Text> : null}
        <Feather name="chevron-down" size={14} color={color.inkSoft} />
      </View>
    </Menu>
  );
}

const FLOOR_ROUTE_SEGMENTS: Record<string, string[]> = {
  [SANITARY_FLOOR_ID]: ["quotations", "purchases", "purchase-orders"],
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
const TILES_ITEMS: NavItem[] = [
  { href: "/(admin)/tiles", label: "Quotation Tiles", icon: "layers", match: "tiles" },
  // Tile Orders' read endpoints require the backend's `sales` level. Keep
  // the selection workflow visible to a Worker, but do not link them to a
  // screen that can only respond with a 403 / "Insufficient role".
  { href: "/(admin)/tiles/orders", label: "Tile Orders", icon: "truck", match: "orders", roles: ["owner", "admin", "manager", "accounts", "purchase", "sales"] },
];

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
        {visible(PRIMARY).map((n) => (
          <SideItem key={n.href} item={n} active={isActive(n)} onPress={() => router.push(n.href as any)} compact={collapsed} />
        ))}
        {tilesNav.items.map((n) => (
          <SideItem
            key={n.href}
            item={n}
            active={n.match === "orders" ? segments.includes("orders") : segments.includes("tiles") && !segments.includes("orders")}
            onPress={() => { void tilesNav.open(n); }}
            compact={collapsed}
          />
        ))}
        <View style={{ height: space.x5 }} />
        {visible(SECONDARY).map((n) => (
          <SideItem key={n.href} item={n} active={isActive(n)} onPress={() => router.push(n.href as any)} compact={collapsed} />
        ))}
      </ScrollView>

      <View style={{ padding: space.x3, gap: space.x3, alignItems: collapsed ? "center" : "stretch" }}>
        <Hairline />
        <Menu
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
        accessibilityState={{ selected: on }}
        onPress={() => router.push(item.href as any)}
        style={({ pressed, hovered }: any) => [
          styles.railItem,
          { backgroundColor: on ? color.sunken : pressed || hovered ? color.hoverWash : "transparent" },
        ]}
      >
        <View style={[styles.brassBarRail, { backgroundColor: on ? color.brass : "transparent" }]} />
        <Feather name={item.icon} size={18} color={on ? color.ink : color.inkSoft} />
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
                { backgroundColor: on ? color.sunken : pressed || hovered ? color.hoverWash : "transparent" },
              ]}
            >
              <View style={[styles.brassBarRail, { backgroundColor: on ? color.brass : "transparent" }]} />
              <Feather name={n.icon} size={18} color={on ? color.ink : color.inkSoft} />
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
const PHONE_TABS: NavItem[] = [
  { href: "/(admin)/dashboard", label: "Home", icon: "home", match: "dashboard" },
  // On Sanitary this starts at quotations; on Ground Floor the same slot is
  // substituted with Tile Orders below. Both are the worker's order queue.
  { href: "/(admin)/quotations", label: "Orders", icon: "file-text", match: "quotations", floors: [SANITARY_FLOOR_ID] },
];
const PHONE_TABS_RIGHT: NavItem[] = [
  { href: "/(admin)/followups", label: "Tasks", icon: "check-square", match: "followups" },
];
const MORE_ITEMS: NavItem[] = [
  { href: "/(admin)/walkins", label: "Walk-ins", icon: "user-plus", match: "walkins" },
  { href: "/(admin)/catalog", label: "Catalog", icon: "package", match: "catalog" },
  { href: "/(admin)/customers", label: "Customers", icon: "users", match: "customers" },
  { href: "/(admin)/purchases", label: "Purchases", icon: "shopping-cart", match: "purchases", floors: [SANITARY_FLOOR_ID] },
  { href: "/(admin)/payments", label: "Payments", icon: "credit-card", match: "payments" },
  { href: "/(admin)/payments-list", label: "Payment List", icon: "list", match: "payments-list" },
  { href: "/(admin)/notebook/kitchen", label: "Kitchen Walk-ins", icon: "user-plus", match: "kitchen", floors: [KITCHEN_FLOOR_ID] },
  { href: "/(admin)/notebook/kitchen/quotation-follow-up", label: "Quotation Follow-up", icon: "file-text", match: "quotation-follow-up", floors: [KITCHEN_FLOOR_ID] },
  { href: "/(admin)/notebook/furniture", label: "Furniture Walk-ins", icon: "user-plus", match: "furniture", floors: [FURNITURE_FLOOR_ID] },
  { href: "/(admin)/notebook/furniture/quotation-follow-up", label: "Quotation Follow-up", icon: "file-text", match: "quotation-follow-up", floors: [FURNITURE_FLOOR_ID] },
  { href: "/(admin)/notifications", label: "Notifications", icon: "bell", match: "notifications" },
  { href: "/(admin)/sales-data", label: "Sales Data", icon: "trending-up", match: "sales-data" },
  { href: "/(admin)/team", label: "Team", icon: "user-check", match: "team", roles: ["owner", "admin", "manager"] },
  { href: "/(admin)/settings", label: "Settings", icon: "settings", match: "settings" },
];

function PhoneBar() {
  const router = useRouter();
  const segments = useSegments() as string[];
  const { staff, logout } = useAuth();
  const visible = useVisibleNav();
  const hasAccess = useModuleAccess();
  const palette = usePalette();
  const tilesNav = useTilesNav();
  const { access, selectedFloorId, loading: floorLoading } = useFloorAccess();
  const { loading: permissionsLoading } = usePermissionMatrix();
  const [moreOpen, setMoreOpen] = useState(false);
  const isActive = (item: NavItem) => isNavActive(item, segments);
  // The footer is part of the application shell, so it must obey the same
  // readiness boundary as the routed screen. Rendering its real destinations
  // before the signed-in user's floor and permission matrix resolve made the
  // icons visibly change (and briefly exposed a wrong-floor destination) on
  // cold starts. A fixed, inert placeholder preserves the layout until the
  // authoritative shell state is available.
  const shellReady = Boolean(staff && access && selectedFloorId && !floorLoading && !permissionsLoading);
  if (!shellReady) return <PhoneBarSkeleton />;

  const visibleMore = visible(MORE_ITEMS);
  const moreActive = visibleMore.some(isActive);
  // The left tab slot is Quotes on Sanitary Bathroom. On Ground Floor that
  // destination doesn't exist, so the slot takes that unit's equivalent
  // (Quotation Tiles) rather than collapsing and leaving a hole in the bar.
  const visiblePhoneTabs = visible(PHONE_TABS);
  // Notebook floors are deliberately a two-page mobile workspace. Generic
  // navigation is hidden there, so keep both pages in the fixed bottom-bar
  // slots instead of leaving the right slot empty and burying follow-up in
  // More. This preserves the normal five-slot alignment at every viewport.
  const contextualNotebookTabs = selectedFloorId === KITCHEN_FLOOR_ID
    ? {
      primary: { href: "/(admin)/notebook/kitchen", label: "Kitchen", icon: "user-plus" as FeatherName, match: "kitchen", floors: [KITCHEN_FLOOR_ID] },
      secondary: { href: "/(admin)/notebook/kitchen/quotation-follow-up", label: "Follow-up", icon: "file-text" as FeatherName, match: "quotation-follow-up", floors: [KITCHEN_FLOOR_ID] },
    }
    : selectedFloorId === FURNITURE_FLOOR_ID
    ? {
      primary: { href: "/(admin)/notebook/furniture", label: "Furniture", icon: "user-plus" as FeatherName, match: "furniture", floors: [FURNITURE_FLOOR_ID] },
      secondary: { href: "/(admin)/notebook/furniture/quotation-follow-up", label: "Follow-up", icon: "file-text" as FeatherName, match: "quotation-follow-up", floors: [FURNITURE_FLOOR_ID] },
    }
    : null;
  const phoneTabs = contextualNotebookTabs
    ? [...visiblePhoneTabs.filter((item) => item.match !== "quotations"), contextualNotebookTabs.primary]
    : visiblePhoneTabs.length < PHONE_TABS.length && tilesNav.items.length
    ? [...visiblePhoneTabs, { ...tilesNav.items[0], label: "Orders" }]
    : visiblePhoneTabs;
  const phoneTabsRight = contextualNotebookTabs ? [contextualNotebookTabs.secondary] : visible(PHONE_TABS_RIGHT);
  // The FAB is not a NavItem and isn't run through visible(), so it needs its
  // own unit check: it used to unconditionally open the Sanitary Quotation
  // Builder, which on Ground Floor doesn't exist for that unit and silently
  // flipped the active business unit to Sanitary just by pressing it. Mirror
  // phoneTabs' substitution — Sanitary gets the quotation builder, every
  // other unit gets that unit's own Tiles nav destination via the same
  // useTilesNav() mechanism, and if neither is available the FAB hides
  // rather than reaching into the other unit's routes.
  //
  // The predicate must be POSITIVE, not `!== TILES_FLOOR_ID`: selectedFloorId
  // starts as "" while useFloorAccess() resolves asynchronously, and a
  // negative predicate put that unresolved state in the Sanitary branch — a
  // multi-floor user sitting on Ground Floor who tapped + before hydration
  // completed landed in the Sanitary Quotation Builder, which itself flips
  // the active floor. A positive match on each concrete floor id leaves the
  // unresolved "" state inert (no branch matches, FAB hides).
  const fabAction = !hasAccess("quotations")
    ? null
    : selectedFloorId === SANITARY_FLOOR_ID
    ? { label: "Scan or start an order", onPress: () => router.push("/(admin)/quotations/new" as any) }
    : selectedFloorId === TILES_FLOOR_ID && tilesNav.items.length
    ? { label: "Scan or start an order", onPress: () => { void tilesNav.open(tilesNav.items[0]); } }
    : null;

  const Tab = ({ item }: { item: NavItem }) => {
    const on = isActive(item);
    return (
      <Pressable
        testID={`bottom-nav-${item.match}`}
        onPress={() => router.push(item.href as any)}
        accessibilityRole="link"
        accessibilityLabel={item.label}
        accessibilityState={{ selected: on }}
        style={styles.tab}
      >
        <View style={[styles.tabIconWrap, on && styles.tabIconWrapActive]}>
          <Feather name={item.icon} size={19} color={on ? color.brass : color.inkFaint} />
        </View>
        <Text style={[styles.tabLabel, on && styles.tabLabelActive]}>{item.label}</Text>
      </Pressable>
    );
  };

  // Kitchen and Furniture are intentionally compact, two-view workspaces.
  // The generic phone footer previously left an empty FAB well between the
  // two notebook tabs and duplicated both destinations again under More.
  if (contextualNotebookTabs) {
    const notebookLabel = selectedFloorId === KITCHEN_FLOOR_ID ? "Kitchen" : "Furniture";
    const notebookMoreLabel = `${notebookLabel} workspace`;
    return <>
      <View style={styles.notebookPhoneBar}>
        <Tab item={contextualNotebookTabs.primary} />
        <Tab item={contextualNotebookTabs.secondary} />
        <Pressable testID="bottom-nav-notebook-workspace" onPress={() => setMoreOpen(true)} accessibilityRole="button" accessibilityLabel={`Open ${notebookMoreLabel} menu`} style={styles.notebookWorkspaceTab}>
          <View style={styles.tabIconWrap}><Feather name="layers" size={19} color={color.inkFaint} /></View>
          <Text style={styles.tabLabel}>Workspace</Text>
        </Pressable>
      </View>
      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title={notebookMoreLabel}>
        <View style={{ paddingVertical: 6 }}><FloorSwitcher /></View>
        <Hairline style={{ marginVertical: 6 }} />
        <Pressable onPress={async () => { setMoreOpen(false); await logout(); router.replace("/(auth)/login"); }} accessibilityRole="button" accessibilityLabel="Sign out" style={styles.moreRow}>
          <Feather name="log-out" size={17} color={color.risk} />
          <Text style={[styles.moreLabel, { color: color.risk }]}>Sign out</Text>
        </Pressable>
      </Sheet>
    </>;
  }

  return (
    <>
      <View style={styles.phoneBar}>
        {phoneTabs.map((t) => <Tab key={t.href} item={t} />)}
        <View style={styles.fabSlot}>
          {fabAction ? (
            <>
            <Pressable
              testID="bottom-fab-new-quotation"
              accessibilityRole="button"
              accessibilityLabel={fabAction.label}
              onPress={fabAction.onPress}
              style={({ pressed }) => [styles.fab, { transform: [{ scale: pressed ? 0.94 : 1 }] }]}
            >
              <Feather name="plus" size={22} color={color.onAction} />
            </Pressable>
            <Text style={styles.actionLabel}>Action</Text>
            </>
          ) : null}
        </View>
        {phoneTabsRight.map((t) => <Tab key={t.href} item={t} />)}
        <Pressable
          testID="bottom-nav-more"
          onPress={() => setMoreOpen(true)}
          accessibilityRole="button"
          accessibilityLabel="More"
          accessibilityState={{ selected: moreActive }}
          style={styles.tab}
        >
          <View style={[styles.tabIconWrap, moreActive && styles.tabIconWrapActive]}>
            <Feather name="menu" size={19} color={moreActive ? color.brass : color.inkFaint} />
          </View>
          <Text style={[styles.tabLabel, moreActive && styles.tabLabelActive]}>More</Text>
        </Pressable>
      </View>

      <Sheet open={moreOpen} onClose={() => setMoreOpen(false)} title="More">

        <Pressable
          onPress={() => { setMoreOpen(false); setTimeout(palette.open, 250); }}
          accessibilityRole="button"
          accessibilityLabel="Search everything"
          style={styles.moreRow}
        >
          <Feather name="search" size={17} color={color.inkMid} />
          <Text style={styles.moreLabel}>Search everything</Text>
        </Pressable>
        <View style={{ paddingVertical: 6 }}>
          <FloorSwitcher />
        </View>
        <Hairline style={{ marginVertical: 6 }} />
        {tilesNav.items.map((n) => (
          <Pressable
            key={n.href}
            onPress={() => { setMoreOpen(false); void tilesNav.open(n); }}
            accessibilityRole="link"
            accessibilityLabel={n.label}
            style={styles.moreRow}
          >
            <Feather name={n.icon} size={17} color={color.inkMid} />
            <Text style={styles.moreLabel}>{n.label}</Text>
          </Pressable>
        ))}
        {tilesNav.items.length ? <Hairline style={{ marginVertical: 6 }} /> : null}
        {visibleMore.map((n) => (
          <Pressable
            key={n.href}
            onPress={() => { setMoreOpen(false); router.push(n.href as any); }}
            accessibilityRole="link"
            accessibilityLabel={n.label}
            style={styles.moreRow}
          >
            <Feather name={n.icon} size={17} color={color.inkMid} />
            <Text style={styles.moreLabel}>{n.label}</Text>
          </Pressable>
        ))}
        <Hairline style={{ marginVertical: 6 }} />
        <View style={[styles.moreRow, { justifyContent: "space-between" }]}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <Avatar name={staff?.full_name} size={30} />
            <View>
              <Text style={{ fontFamily: font.medium, fontSize: 13.5, color: color.ink }}>{staff?.full_name}</Text>
              <Text style={{ fontFamily: font.regular, fontSize: 11.5, color: color.inkSoft }}>
                {roleLabel[staff?.role || ""] || staff?.role}
              </Text>
            </View>
          </View>
          <Pressable
            onPress={async () => { setMoreOpen(false); await logout(); router.replace("/(auth)/login"); }}
            hitSlop={layout.hitSlop}
          >
            <Text style={{ fontFamily: font.medium, fontSize: 13, color: color.risk }}>Sign out</Text>
          </Pressable>
        </View>
      </Sheet>
    </>
  );
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
    : segments.includes("purchases") || segments.includes("purchase-orders") ? "purchases"
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
          <FloorAccessGate><CustomAccessRouteGate><Slot /></CustomAccessRouteGate></FloorAccessGate>
        </AppScaffold>
      </PaletteProvider>
    );
  }

  return (
    <PaletteProvider>
      <View style={{ flex: 1, flexDirection: "row", backgroundColor: color.canvas }}>
        <View style={{
          width: isTablet ? layout.rail : sidebarCollapsed ? layout.rail : layout.sidebar,
          borderRightWidth: layout.hairline, borderRightColor: color.line,
          ...(Platform.OS === "web" ? ({ transition: "width 200ms cubic-bezier(0.2, 0, 0, 1)" } as any) : {}),
        }}>
          {isTablet ? <Rail /> : <Sidebar collapsed={sidebarCollapsed} onToggle={toggleSidebar} />}
        </View>
        <View style={{ flex: 1, minWidth: 0, minHeight: 0 }}>
          <FloorAccessGate><CustomAccessRouteGate><Slot /></CustomAccessRouteGate></FloorAccessGate>
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
  sidebar: { flex: 1, backgroundColor: color.canvas },
  rail: { flex: 1, backgroundColor: color.canvas },
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
    position: "absolute", left: 0, top: 10, bottom: 10, width: 2.5, borderRadius: 2,
  },
  railItem: {
    width: 42, height: 42, borderRadius: radius.sm,
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
  tabLabel: { fontFamily: font.medium, fontWeight: "500", fontSize: 10.5, color: color.inkFaint, letterSpacing: 0.1 },
  tabLabelActive: { color: color.ink, fontWeight: "600" },
  fabSlot: { width: 68, alignItems: "center", justifyContent: "center", paddingTop: 4 },
  fab: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: color.brass,
    alignItems: "center", justifyContent: "center", marginTop: -22,
    borderWidth: 4, borderColor: color.canvas,
  },
  actionLabel: { marginTop: -2, fontFamily: font.medium, fontSize: 10.5, color: color.inkFaint },
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
