import { usePathname, useRouter } from "expo-router";
import { Platform, Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { useBp } from "@/src/design/responsive";
import { colors, spacing, type } from "@/src/theme/tokens";

export const SALES_DESTINATIONS = [
  { key: "sales", label: "Sales", route: "/(admin)/sales-data" },
  { key: "references", label: "References", route: "/(admin)/sales-data/relationships" },
  { key: "customers", label: "Customers", route: "/(admin)/sales-data/customers" },
] as const;

/** Three direct destinations, without a report menu or second navigation tier. */
export function WorkspaceSwitcher() {
  const pathname = usePathname();
  const router = useRouter();
  const { gutter, isPhone } = useBp();
  const active = /\/(relationships|referrals|referrer|people)(\/|$)/.test(pathname) ? "references"
    : /\/(customers|collections|today)(\/|$)/.test(pathname) ? "customers" : "sales";
  return <View accessibilityRole="tablist" accessibilityLabel="Sales data views" style={{ flexDirection: "row", paddingHorizontal: gutter, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.border }}>
    {SALES_DESTINATIONS.map((item, index) => <Pressable
      key={item.key} testID={`sales-nav-${item.key}`}
      accessibilityRole="tab" accessibilityState={{ selected: active === item.key }}
      tabIndex={active === item.key ? 0 : -1}
      {...(Platform.OS === "web" ? { onKeyDown: (event: React.KeyboardEvent) => {
        const next = event.key === "ArrowRight" ? (index + 1) % SALES_DESTINATIONS.length
          : event.key === "ArrowLeft" ? (index + SALES_DESTINATIONS.length - 1) % SALES_DESTINATIONS.length
          : event.key === "Home" ? 0 : event.key === "End" ? SALES_DESTINATIONS.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        router.push(SALES_DESTINATIONS[next].route as never);
        requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-testid="sales-nav-${SALES_DESTINATIONS[next].key}"]`)?.focus());
      }} : {})}
      onPress={() => { if (active !== item.key || pathname !== item.route.replace("/(admin)", "")) router.push(item.route as never); }}
      style={({ pressed, hovered }: any) => ({
        flex: isPhone ? 1 : undefined, minWidth: 0, minHeight: 48,
        paddingHorizontal: isPhone ? spacing.s4 : spacing.s20,
        alignItems: "center", justifyContent: "center",
        borderBottomWidth: 2, borderBottomColor: active === item.key ? colors.onSurface : "transparent",
        backgroundColor: pressed || hovered ? colors.surfaceTertiary : "transparent",
      })}
    ><Text style={[type.bodyStrong, { color: active === item.key ? colors.onSurface : colors.onSurfaceSecondary }]}>{item.label}</Text></Pressable>)}
  </View>;
}
