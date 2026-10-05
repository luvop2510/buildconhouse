import { useOverlayFocus } from "./useOverlayFocus";
import { NAVIGATION as NAV } from "./navigation";
import { useModuleAccess } from "@/src/hooks/use-permissions";
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
  const [open, setOpen] = useState(false);
  const openPalette = useCallback(() => setOpen(true), []);
  const value = useMemo(() => ({ open: openPalette }), [openPalette]);

  // Global ⌘K / Ctrl+K on web.
  useEffect(() => {
    if (Platform.OS !== "web") return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <PaletteContext.Provider value={value}>
      {children}
      <PaletteHost open={open} onClose={() => setOpen(false)} />
    </PaletteContext.Provider>
  );
}

function PaletteHost({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const { selectedFloorId } = useFloorAccess();
  const { staff } = useAuth();
  const hasAccess = useModuleAccess();
  const canCustomers = hasAccess("customers");
  const canQuotes = hasAccess("quotations") && selectedFloorId === "first-floor";
  const canCatalog = hasAccess("catalog");
  const panelRef = useOverlayFocus(open, onClose);
  const reducedMotion = useReducedMotion();
  const notebookOnly = selectedFloorId === KITCHEN_FLOOR_ID || selectedFloorId === FURNITURE_FLOOR_ID;
  const { width: winW, height: winH } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const isPhone = winW < layout.bp.tablet;

  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [customers, setCustomers] = useState<any[]>([]);
  const [quotations, setQuotations] = useState<any[]>([]);
  const [products, setProducts] = useState<any[]>([]);
  const inputRef = useRef<TextInput>(null);
  const anim = useRef(new Animated.Value(0)).current;
  const [visible, setVisible] = useState(open);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Open/close animation + focus.
  useEffect(() => {
    if (open) {
      setVisible(true);
      setQ(""); setSel(0); setProducts([]); setCustomers([]); setQuotations([]);
      Animated.timing(anim, { toValue: 1, duration: reducedMotion ? 0 : motion.standard, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start();
      setTimeout(() => inputRef.current?.focus(), 60);
      // Prefetch light indexes once per open.
      if (!notebookOnly) {
        if (canCustomers) api.get<any[]>("/customers").then(setCustomers).catch(() => {});
        if (canQuotes) api.get<any[]>("/quotations").then((d: any) => setQuotations(Array.isArray(d) ? d : d?.items ?? [])).catch(() => {});
      }
    } else {
      Animated.timing(anim, { toValue: 0, duration: reducedMotion ? 0 : motion.quick, easing: Easing.in(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start(({ finished }) => {
        if (finished) setVisible(false);
      });
    }
  }, [open, anim, notebookOnly, reducedMotion, canCustomers, canQuotes]);

  // Product search — server-side, debounced.
  useEffect(() => {
    if (!open || notebookOnly || !canCatalog) return;
    if (debounce.current) clearTimeout(debounce.current);
    if (q.trim().length < 2) { setProducts([]); return; }
    const controller = new AbortController();
    debounce.current = setTimeout(() => {
      api.get<any>(`/products?q=${encodeURIComponent(q.trim())}&limit=5`, { signal: controller.signal })
        .then((d) => setProducts(d?.items ?? []))
        .catch((error) => {
          if (!controller.signal.aborted) setProducts([]);
        });
    }, 180);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
      controller.abort();
    };
  }, [q, open, notebookOnly, canCatalog]);

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
    ] as Item[]).filter(a => hasAccess(a.key === "a-newq" ? "quotations" : a.key === "a-cust" ? "customers" : "payments")).filter((a) => match(a.title + " " + a.keywords));

    const nav: Item[] = NAV
      .filter(n => (!n.floors || n.floors.includes(selectedFloorId)) && (!n.roles || !!staff && n.roles.includes(staff.role)) && hasAccess(n.match))
      .filter(n => !n.href.includes("/tiles") || selectedFloorId === "ground-floor")
      .filter((n) => !notebookOnly || (selectedFloorId === KITCHEN_FLOOR_ID ? n.href.includes("/notebook/kitchen") : n.href.includes("/notebook/furniture")))
      .filter((n) => match(n.label + " " + n.match))
      .map((n) => ({
        key: `n-${n.href}`, section: "Go to", icon: n.icon, title: n.label, run: () => go(n.href),
      }));

    const cust: Item[] = notebookOnly || !needle ? [] : customers
      .filter((c) => match(`${c.name} ${c.company ?? ""} ${c.city ?? ""} ${c.email ?? ""}`))
      .slice(0, 4)
      .map((c) => ({
        key: `c-${c.id}`, section: "Customers", icon: "user", title: c.name,
        sub: [c.company, c.city].filter(Boolean).join(" · ") || undefined,
        run: () => go(`/(admin)/customers/${c.id}`),
      }));

    const quots: Item[] = notebookOnly || !needle ? [] : quotations
      .filter((x) => match(`${x.number} ${x.customer_name ?? ""}`))
      .slice(0, 4)
      .map((x) => ({
        key: `q-${x.id}`, section: "Quotations", icon: "file-text",
        title: `${x.number} · ${x.customer_name ?? ""}`,
        meta: `₹${fmtMoneyCompact(x.grand_total ?? 0)}`,
        run: () => go(`/(admin)/quotations/${x.id}`),
      }));

    const prods: Item[] = notebookOnly ? [] : products.slice(0, 5).map((p) => ({
      key: `p-${p.id}`, section: "Products", icon: "package", title: p.name,
      sub: p.sku, meta: p.price ? `₹${fmtMoneyCompact(p.price)}` : undefined,
      run: () => go(`/(admin)/catalog/${p.id}`),
    }));

    return [...actions, ...(needle ? [...cust, ...quots, ...prods] : []), ...nav];
  }, [q, customers, quotations, products, go, notebookOnly, selectedFloorId, staff, hasAccess]);

  // Clamp selection.
  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, items.length - 1))); }, [items.length]);

  // Web keyboard navigation while open.
  useEffect(() => {
    if (Platform.OS !== "web" || !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, items.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
      else if (e.key === "Enter") { e.preventDefault(); items[sel]?.run(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, items, sel, onClose]);

  if (!visible) return null;

  let lastSection = "";

  return (
    <Modal visible transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: color.scrim, opacity: anim }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} />
        </Animated.View>

        <Animated.View ref={panelRef} role="dialog" aria-modal accessibilityLabel="Search workspace" tabIndex={-1}
          style={[
            {
              backgroundColor: color.surface, overflow: "hidden",
              opacity: anim, ...shadow.overlay,
            },
            isPhone
              ? { flex: 1, marginTop: insets.top, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }
              : {
                  alignSelf: "center", width: Math.min(620, winW - 64),
                  maxHeight: Math.min(460, winH - 160), marginTop: Math.max(70, winH * 0.14),
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
