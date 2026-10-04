import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import Feather from '@expo/vector-icons/Feather';
import { Animated, Easing, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { color, font, layout, motion, radius, shadow } from './tokens';
import { useReducedMotion } from '@/src/hooks/use-reduced-motion';
import { useOverlayFocus } from './useOverlayFocus';
import { NavigationTabs } from './NavigationTabs';
import { webCursor, type FeatherName } from './shared';

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
export function Tabs<T extends string>({ items, value, onChange }: {
  items: { key: T; label: string; count?: number }[]; value: T; onChange: (key: T) => void;
}) { return <NavigationTabs value={value} options={items.map(item => ({ ...item, value: item.key }))} onChange={onChange} />; }
export type MenuItem = { label: string; icon?: FeatherName; tone?: "ink" | "risk"; onPress: () => void };

export function Menu({
  items, children, align = "right", triggerLabel, triggerTestID,
}: { items: MenuItem[]; children: React.ReactNode; align?: "left" | "right"; triggerLabel?: string; triggerTestID?: string }) {
  const ref = useRef<View>(null);
  const [pos, setPos] = useState<{ x: number; y: number; w: number } | null>(null);
  const { width: winW, height: winH } = useWindowDimensions();
  const anim = useRef(new Animated.Value(0)).current;
  const reducedMotion = useReducedMotion();
  const panelRef = useOverlayFocus(!!pos, () => setPos(null));

  const openMenu = useCallback(() => {
    ref.current?.measureInWindow((x, y, w, h) => {
      setPos({ x, y: y + h + 6, w });
      anim.setValue(0);
      Animated.timing(anim, { toValue: 1, duration: reducedMotion ? 0 : motion.quick, easing: Easing.out(Easing.cubic), useNativeDriver: Platform.OS !== "web" }).start();
    });
  }, [anim, reducedMotion]);

  const MENU_W = 216;
  const left = pos ? Math.max(12, Math.min(align === "right" ? pos.x + pos.w - MENU_W : pos.x, winW - MENU_W - 12)) : 0;
  const top = pos ? Math.max(12, Math.min(pos.y, winH - Math.min(items.length * 44 + 12, winH - 24) - 12)) : 0;

  return (
    <>
      <Pressable
        ref={ref as any}
        testID={triggerTestID}
        accessibilityRole="button"
        accessibilityLabel={triggerLabel || "Open menu"}
        accessibilityState={{ expanded: !!pos }}
        aria-haspopup="menu"
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
            ref={panelRef} role="menu" tabIndex={-1} accessibilityLabel={triggerLabel || "Actions"}
            style={[{
              position: "absolute", left, top, width: MENU_W,
              backgroundColor: color.surface, borderRadius: radius.lg,
              borderWidth: layout.hairline, borderColor: color.line,
              paddingVertical: 6, opacity: anim,
              transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [-4, 0] }) }],
              ...shadow.overlay,
            }]}
          >
            <ScrollView keyboardShouldPersistTaps="handled" style={{ maxHeight: winH - 48 }}>
            {items.map((it, i) => (
              <Pressable
                key={i}
                accessibilityRole="menuitem" accessibilityLabel={it.label}
                {...(Platform.OS === "web" ? { onKeyDown: (event: React.KeyboardEvent) => {
                  const el = event.currentTarget as HTMLElement;
                  const siblings = Array.from(el.parentElement?.querySelectorAll<HTMLElement>('[role="menuitem"]') || []);
                  const next = event.key === "ArrowDown" ? (i + 1) % siblings.length : event.key === "ArrowUp" ? (i + siblings.length - 1) % siblings.length : event.key === "Home" ? 0 : event.key === "End" ? siblings.length - 1 : -1;
                  if (next >= 0) { event.preventDefault(); siblings[next]?.focus(); }
                }} : {})}
                onPress={() => { setPos(null); it.onPress(); }}
                style={({ pressed, hovered }: any) => [
                  {
                    flexDirection: "row", alignItems: "center", gap: 10,
                    paddingHorizontal: 14, minHeight: 44,
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
            </ScrollView>
          </Animated.View>
        ) : null}
      </Modal>
    </>
  );
}
export const PaletteContext = createContext<{ open: () => void }>({ open: () => {} });
export const usePalette = () => useContext(PaletteContext);
