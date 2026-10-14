import { useOverlayFocus } from "./useOverlayFocus";
import { NAVIGATION as NAV } from "./navigation";
import { useActionAccess, useModuleAccess } from "@/src/hooks/use-permissions";
import { useAuth } from "@/src/state/auth";
import { useReducedMotion } from "@/src/hooks/use-reduced-motion";
// ─────────────────────────────────────────────────────────────────────────────
// Command palette — the app's fast lane. ⌘K anywhere.
// Actions + navigation instantly; customers, quotations and products as you type.
// ─────────────────────────────────────────────────────────────────────────────
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Animated, Easing, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import { FURNITURE_FLOOR_ID, KITCHEN_FLOOR_ID } from "@/src/constants/floors";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { FeatherName, KeyCap, PaletteContext } from "./components";
import { color, fmtMoneyCompact, font, layout, motion, radius, shadow, space } from "./tokens";

type Item = {
  key: string;
  section: "Actions" | "Go to" | "Customers" | "Quotations" | "Products";
  icon: FeatherName;
  title: string;
  sub?: string;
  meta?: string;
  keywords?: string;
  run: () => void;
};

export function PaletteProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState({ open: false, id: 0 });
  const openPalette = useCallback(() => setSession((current) => current.open
    ? current : { open: true, id: current.id + 1 }), []);
  const value = useMemo(() => ({ open: openPalette }), [openPalette]);

  // Capture shortcuts before web TextInput stops bubbling keydown events.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSession((current) => ({
          open: !current.open, id: current.open ? current.id : current.id + 1,
        }));
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <PaletteContext.Provider value={value}>
      {children}
      <PaletteHost key={session.id} open={session.open} onClose={() => setSession((current) =>
        current.id === session.id ? { ...current, open: false } : current)} />
    </PaletteContext.Provider>
  );
}

function PaletteHost(props: { open: boolean; onClose: () => void }) {
  const { selectedFloorId } = useFloorAccess();
  return <PaletteSession key={selectedFloorId} {...props} selectedFloorId={selectedFloorId} />;
}

function PaletteSession({ open, onClose, selectedFloorId }: { open: boolean; onClose: () => void; selectedFloorId: string }) {
  const router = useRouter();
  const { staff } = useAuth();
  const hasAccess = useModuleAccess();
  const canCustomers = hasAccess("customers");
  const canQuotes = hasAccess("quotations") && selectedFloorId === "first-floor";
  const canCatalog = hasAccess("catalog") && ["ground-floor", "first-floor"].includes(selectedFloorId);
  const canNewQuotation = useActionAccess(selectedFloorId === "ground-floor" ? "tiles" : "quotations", "create");
  const canNewCustomer = useActionAccess("customers", "create");
  const canRecordPayment = useActionAccess("payments", "create");
  const reducedMotion = useReducedMotion();
  const notebookOnly = selectedFloorId === KITCHEN_FLOOR_ID || selectedFloorId === FURNITURE_FLOOR_ID;
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isPhone = winW < layout.bp.tablet;

  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [customers, setCustomers] = useState<any[]>([]);
  const [quotations, setQuotations] = useState<any[]>([]);
  const [productResult, setProductResult] = useState<{ query: string; items: any[] }>({ query: "", items: [] });
  const inputRef = useRef<TextInput>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const [visible, setVisible] = useState(open);
  // The web Modal remains mounted for its exit animation. Keep isolation and
  // focus ownership until that portal actually closes; restoring on `open`
  // let its still-active native focus trap move focus onto the next backdrop.
  const panelRef = useOverlayFocus(visible, onClose, open);
  const productQuery = q.trim();

  // Each opening and floor gets a fresh session; only exit visibility outlives open.
  useEffect(() => {
    const animation = Animated.timing(anim, {
      toValue: open ? 1 : 0,
      duration: reducedMotion ? 0 : open ? motion.standard : motion.quick,
      easing: open ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: Platform.OS !== "web",
    });
    animation.start(({ finished }) => {
      if (finished && !open) setVisible(false);
    });
    // Web overlay focus is established once by useOverlayFocus. A second
    // delayed focus would steal focus from someone already tabbing to a result.
    const focusTimer = open && Platform.OS !== "web" ? setTimeout(() => inputRef.current?.focus(), 60) : undefined;
    return () => {
      animation.stop();
      if (focusTimer !== undefined) clearTimeout(focusTimer);
    };
  }, [open, anim, reducedMotion]);

  // Scope prefetches to this open session; cancelled responses cannot repopulate it.
  useEffect(() => {
    if (!open || !selectedFloorId || notebookOnly) return;
    const controller = new AbortController();
    if (canCustomers) api.get<any[]>("/customers", { signal: controller.signal })
      .then((data) => { if (!controller.signal.aborted) setCustomers(data); }).catch(() => {});
    if (canQuotes) api.get<any[]>("/quotations", { signal: controller.signal })
      .then((data: any) => {
        if (!controller.signal.aborted) setQuotations(Array.isArray(data) ? data : data?.items ?? []);
      }).catch(() => {});
    return () => controller.abort();
  }, [open, selectedFloorId, notebookOnly, canCustomers, canQuotes]);

  // Product search — server-side, debounced. Query tagging hides mismatched results.
  useEffect(() => {
    if (!open || !selectedFloorId || notebookOnly || !canCatalog || productQuery.length < 2) return;
    const controller = new AbortController();
    const debounce = setTimeout(() => {
      api.get<any>(`/products?q=${encodeURIComponent(productQuery)}&limit=5`, { signal: controller.signal })
        .then((data) => {
          if (!controller.signal.aborted) setProductResult({ query: productQuery, items: data?.items ?? [] });
        })
        .catch(() => {
          if (!controller.signal.aborted) setProductResult({ query: productQuery, items: [] });
        });
    }, 180);
    return () => {
      clearTimeout(debounce);
      controller.abort();
    };
  }, [productQuery, open, selectedFloorId, notebookOnly, canCatalog]);

  const go = useCallback((href: string) => {
    onClose();
    setTimeout(() => router.push(href as any), 10);
  }, [onClose, router]);

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const match = (s?: string) => !needle || (s ?? "").toLowerCase().includes(needle);

    const actions: Item[] = (notebookOnly ? [] : [
      { key: "a-newq", section: "Actions", icon: "plus", title: "New quotation", keywords: "create quote", run: () => go(selectedFloorId === "ground-floor" ? "/(admin)/tiles/quotation" : "/(admin)/quotations/new") },
      { key: "a-cust", section: "Actions", icon: "user-plus", title: "Add customer", keywords: "create client", run: () => go("/(admin)/customers/new") },
      { key: "a-pay", section: "Actions", icon: "credit-card", title: "Record a payment", keywords: "collect money", run: () => go("/(admin)/payments") },
    ] as Item[]).filter(a => a.key === "a-newq" ? canNewQuotation && hasAccess(selectedFloorId === "ground-floor" ? "tiles" : "quotations") : a.key === "a-cust" ? canNewCustomer && canCustomers : canRecordPayment && hasAccess("payments")).filter((a) => match(a.title + " " + a.keywords));

    const nav: Item[] = NAV
      .filter(n => (!n.floors || n.floors.includes(selectedFloorId)) && (staff?.custom_access || !n.roles || !!staff && n.roles.includes(staff.role)) && hasAccess(n.match))
      .filter(n => !n.href.includes("/tiles") || selectedFloorId === "ground-floor")
      .filter((n) => match(n.label + " " + n.match))
      .map((n) => ({
        key: `n-${n.href}`, section: "Go to", icon: n.icon, title: n.label, run: () => go(n.href),
      }));

    const cust: Item[] = notebookOnly || !canCustomers || !needle ? [] : customers
      .filter((c) => match(`${c.name} ${c.company ?? ""} ${c.city ?? ""} ${c.email ?? ""}`))
      .slice(0, 4)
      .map((c) => ({
        key: `c-${c.id}`, section: "Customers", icon: "user", title: c.name,
        sub: [c.company, c.city].filter(Boolean).join(" · ") || undefined,
        run: () => go(`/(admin)/customers/${c.id}`),
      }));

    const quots: Item[] = notebookOnly || !canQuotes || !needle ? [] : quotations
      .filter((x) => match(`${x.number} ${x.customer_name ?? ""}`))
      .slice(0, 4)
      .map((x) => ({
        key: `q-${x.id}`, section: "Quotations", icon: "file-text",
        title: `${x.number} · ${x.customer_name ?? ""}`,
        meta: `₹${fmtMoneyCompact(x.grand_total ?? 0)}`,
        run: () => go(`/(admin)/quotations/${x.id}`),
      }));

    const products = canCatalog && productQuery.length >= 2 && productResult.query === productQuery
      ? productResult.items : [];
    const prods: Item[] = notebookOnly ? [] : products.slice(0, 5).map((p) => ({
      key: `p-${p.id}`, section: "Products", icon: "package", title: p.name,
      sub: p.sku, meta: p.price ? `₹${fmtMoneyCompact(p.price)}` : undefined,
      run: () => go(`/(admin)/catalog/${p.id}`),
    }));

    return [...actions, ...(needle ? [...cust, ...quots, ...prods] : []), ...nav];
  }, [q, customers, quotations, productQuery, productResult, canCatalog, go, notebookOnly, selectedFloorId, staff, hasAccess, canCustomers, canQuotes, canNewQuotation, canNewCustomer, canRecordPayment]);

  // Keep selection valid as asynchronous results change.
  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, items.length - 1))); }, [items.length]);

  // Capture navigation before web TextInput consumes it; only the focused overlay acts.
  useEffect(() => {
    if (Platform.OS !== "web" || !open) return;
    const onKey = (e: KeyboardEvent) => {
      const panel = panelRef.current as unknown as HTMLElement | null;
      if (!panel?.contains(document.activeElement) || e.isComposing) return;
      // useOverlayFocus dismisses on keyup and stops that event after the
      // top overlay handles it. Closing on keydown would restore focus into
      // an underlying dialog before the same Escape's keyup reaches it.
      // Tabbable results and Cancel keep their own keyboard activation. Selection
      // belongs to the search input; Tab focus can point at a different action.
      const input = inputRef.current as unknown as HTMLElement | null;
      if (document.activeElement !== input && document.activeElement !== panel) return;
      if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, Math.max(0, items.length - 1))); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); items[sel]?.run(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, items, sel, onClose, panelRef]);

  if (!visible) return null;

  let lastSection = "";

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView enabled={Platform.OS !== "web"} behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim, opacity: anim }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        <Animated.View ref={panelRef} role="dialog" aria-modal accessibilityLabel="Search workspace" tabIndex={-1}
          style={[
            {
              backgroundColor: color.surface, overflow: "hidden", minHeight: 0, flexShrink: 1,
              opacity: anim, ...shadow.overlay,
            },
            isPhone
              ? { flex: 1, marginTop: insets.top, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }
              : {
                  alignSelf: "center", width: Math.min(620, winW - 64),
                  maxHeight: Platform.OS === "web" ? 'min(460px, calc(var(--forge-visible-height, 100dvh) - 40px))' as unknown as number : Math.min(460, winH - 160),
                  marginTop: Platform.OS === "web" ? 'min(70px, calc(var(--forge-visible-height, 100dvh) * .14))' as unknown as number : Math.max(70, winH * 0.14),
                  borderRadius: radius.xl,
                  transform: [
                    { translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-8, 0] }) },
                  ],
                },
          ]}
        >
          {/* Input row */}
          <View style={{
            flexDirection: "row", alignItems: "center", gap: 12,
            paddingHorizontal: space.x5, height: 56,
          }}>
            <Feather name="search" size={17} color={color.inkSoft} />
            <TextInput
              ref={inputRef}
              value={q}
              onChangeText={(v) => { setQ(v); setSel(0); }}
              placeholder="Search or jump to…"
              accessibilityLabel="Search commands, customers, quotations, and products"
              placeholderTextColor={color.inkFaint}
              autoCapitalize="none"
              autoCorrect={false}
              style={[
                { flex: 1, fontFamily: font.regular, fontSize: 16, color: color.ink, height: "100%" },
                Platform.OS === "web" ? ({ outlineStyle: "none" } as any) : null,
              ]}
              onSubmitEditing={() => items[sel]?.run()}
            />
            {isPhone ? (
              <Pressable onPress={onClose} hitSlop={layout.hitSlop} accessibilityRole="button" accessibilityLabel="Close command palette">
                <Text style={{ fontFamily: font.medium, fontSize: 14, color: color.inkMid }}>Cancel</Text>
              </Pressable>
            ) : <KeyCap label="esc" />}
          </View>
          <View style={{ height: layout.hairline, backgroundColor: color.line }} />

          {/* Results */}
          <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingVertical: space.x2, paddingHorizontal: space.x2 }}>
            {items.length === 0 ? (
              <View style={{ paddingVertical: space.x10, alignItems: "center", gap: 6 }}>
                <Feather name="search" size={18} color={color.inkFaint} />
                <Text style={{ fontFamily: font.regular, fontSize: 14, color: color.inkSoft }}>
                  Nothing matches “{q}”
                </Text>
              </View>
            ) : items.map((it, i) => {
              const showHeader = it.section !== lastSection;
              lastSection = it.section;
              const active = i === sel;
              return (
                <View key={it.key}>
                  {showHeader ? (
                    <Text style={{
                      fontFamily: font.semibold, fontSize: 11, letterSpacing: 1.2,
                      textTransform: "uppercase", color: color.inkFaint,
                      paddingHorizontal: space.x3, paddingTop: i === 0 ? space.x2 : space.x4, paddingBottom: 6,
                    }}>
                      {it.section}
                    </Text>
                  ) : null}
                  <Pressable
                    onPress={it.run}
                    onHoverIn={() => setSel(i)}
                    accessibilityRole="button"
                    accessibilityLabel={[it.title, it.sub, it.meta].filter(Boolean).join(", ")}
                    accessibilityState={{ selected: active }}
                    style={[
                      {
                        flexDirection: "row", alignItems: "center", gap: 12,
                        paddingHorizontal: space.x3, height: 44, borderRadius: radius.md,
                        backgroundColor: active ? color.sunken : "transparent",
                      },
                      Platform.OS === "web" ? ({ cursor: "pointer" } as any) : null,
                    ]}
                  >
                    <Feather name={it.icon} size={16} color={active ? color.ink : color.inkSoft} />
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text numberOfLines={1} style={{
                        fontFamily: font.medium, fontWeight: "500", fontSize: 14.5,
                        color: color.ink, letterSpacing: -0.1,
                      }}>
                        {it.title}
                      </Text>
                      {it.sub ? (
                        <Text numberOfLines={1} style={{ fontFamily: font.regular, fontSize: 12, color: color.inkSoft }}>
                          {it.sub}
                        </Text>
                      ) : null}
                    </View>
                    {it.meta ? (
                      <Text style={{ fontFamily: font.medium, fontSize: 13, color: color.inkMid, fontVariant: ["tabular-nums"] }}>
                        {it.meta}
                      </Text>
                    ) : null}
                    {active && Platform.OS === "web" ? <KeyCap label="↵" /> : null}
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>

          {!isPhone ? (
            <>
              <View style={{ height: layout.hairline, backgroundColor: color.line }} />
              <View style={{
                flexDirection: "row", alignItems: "center", gap: space.x4,
                paddingHorizontal: space.x5, height: 40,
              }}>
                <FooterHint keys={["↑", "↓"]} label="navigate" />
                <FooterHint keys={["↵"]} label="open" />
                <FooterHint keys={["esc"]} label="dismiss" />
              </View>
            </>
          ) : null}
        </Animated.View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function FooterHint({ keys, label }: { keys: string[]; label: string }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5 }}>
      {keys.map((k) => <KeyCap key={k} label={k} />)}
      <Text style={{ fontFamily: font.regular, fontSize: 12, color: color.inkSoft }}>{label}</Text>
    </View>
  );
}
