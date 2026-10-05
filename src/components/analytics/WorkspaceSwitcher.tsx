import { usePathname, useRouter } from "expo-router";
import { useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { Button, Sheet } from "@/src/design/components";
import { useBp } from "@/src/design/responsive";
import { colors, layout, radius, spacing, type } from "@/src/theme/tokens";

type Member = {
  label: string;
  route: string;
  /** False while the workspace is on the roadmap but not yet built. Those
   *  entries stay in the navigation — the architecture is the final one — but
   *  route to the Coming Soon placeholder instead of an unmatched route. */
  implemented: boolean;
};
type Group = { key: string; label: string; members: Member[] };


/**
 * Navigation grouped by the question the owner is asking, not by engineering
 * boundary (spec §16.2). Routes and backend services are unchanged by this
 * grouping — it is presentation only.
 *
 * This list is the complete Sales Data architecture, not just what ships
 * today. Milestone 4 builds the launch dashboard and the workspaces marked
 * `implemented: true`; the rest are real roadmap entries that already have
 * their place in the navigation, so a later milestone adds a screen and flips
 * one flag rather than requiring another navigation redesign.
 *
 * Each group opens to its first implemented member, so a click is never spent
 * on a menu and never lands on a placeholder when real data is one tap away.
 */
export const WORKSPACE_GROUPS: Group[] = [
  { key: "overview", label: "Overview", members: [
    { label: "Sales Data", route: "/(admin)/sales-data", implemented: true },
    { label: "Executive", route: "/(admin)/sales-data/executive", implemented: true },
    { label: "Today's Priorities", route: "/(admin)/sales-data/today", implemented: true },
  ] },
  { key: "money", label: "Money", members: [
    { label: "Revenue", route: "/(admin)/sales-data/sales", implemented: true },
    { label: "Collections", route: "/(admin)/sales-data/collections", implemented: true },
    { label: "Forecasting", route: "/(admin)/sales-data/forecasting", implemented: true },
  ] },
  { key: "customers", label: "Customers", members: [
    { label: "Customers", route: "/(admin)/sales-data/customers", implemented: true },
    { label: "Architects", route: "/(admin)/sales-data/referrals/architects", implemented: true },
    { label: "Interior Designers", route: "/(admin)/sales-data/referrals/interior-designers", implemented: true },
    { label: "Relationships", route: "/(admin)/sales-data/relationships", implemented: true },
  ] },
  { key: "products", label: "Products", members: [
    { label: "Products", route: "/(admin)/sales-data/products", implemented: true },
    { label: "Brands", route: "/(admin)/sales-data/brands", implemented: true },
    { label: "Suppliers", route: "/(admin)/sales-data/suppliers", implemented: true },
  ] },
  { key: "operations", label: "Operations", members: [
    { label: "Operations", route: "/(admin)/sales-data/operations", implemented: true },
  ] },
];

/** Where a member actually navigates. An unbuilt workspace goes to the
 *  placeholder carrying its own name, never to an unmatched route. */
export function destinationFor(member: Member): string { return member.route; }

export function WorkspaceSwitcher() {
  const router = useRouter();
  const pathname = usePathname();
  const { isPhone } = useBp();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // The switcher renders outside AdminPage, so it does not inherit the page's
  // horizontal gutter — the first tab used to sit flush against the screen
  // edge while every card below it was inset, and the last tab was clipped
  // mid-word with nothing to suggest the row scrolled. Padding the scroll
  // CONTENT (not the ScrollView) keeps the row scrollable edge to edge while
  // aligning its first and last items to the same gutter as the page.
  const gutter = isPhone ? layout.screenPadding.phone : layout.screenPadding.tablet;

  // `/sales-data` is a prefix of every other workspace route, so matching it
  // by `startsWith` would light up the Overview group on every screen in the
  // module. The launch dashboard is matched exactly instead.
  const isActiveMember = (member: Member) => {
    const path = member.route.replace("/(admin)", "");
    return path === "/sales-data" ? pathname === path : pathname.startsWith(path);
  };
  const activeGroup = WORKSPACE_GROUPS.find((g) => g.members.some(isActiveMember));

  const openMember = (member: Member) => router.push(destinationFor(member) as never);

  if (isPhone) return (
    <View style={{ paddingHorizontal: gutter, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.surface }}>
      <Button testID="sales-report-selector" label={`Report: ${activeGroup?.members.find(isActiveMember)?.label || "Performance detail"}`} icon="chevron-down" variant="secondary" onPress={() => setPickerOpen(true)} full />
      <Sheet open={pickerOpen} onClose={() => setPickerOpen(false)} title="Choose a report">
        <View style={{ gap: spacing.lg }}>
          {WORKSPACE_GROUPS.map(group => <View key={group.key} style={{ gap: spacing.xs }}>
            <Text accessibilityRole="header" style={type.overline}>{group.label}</Text>
            {group.members.map(member => <Pressable key={member.route} accessibilityRole="link" accessibilityState={{ selected: isActiveMember(member) }} onPress={() => { setPickerOpen(false); openMember(member); }} style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: spacing.md, justifyContent: "center", backgroundColor: isActiveMember(member) ? colors.brandTint : pressed ? colors.surfaceSecondary : "transparent", borderRadius: 6 })}>
              <Text style={[type.bodyStrong, { color: isActiveMember(member) ? colors.brand : colors.onSurface }]}>{member.label}</Text>
            </Pressable>)}
          </View>)}
        </View>
      </Sheet>
    </View>
  );

  return (
    <View style={{
      gap: spacing.sm,
      paddingTop: spacing.sm,
      paddingBottom: spacing.sm,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.border,
      backgroundColor: colors.surface,
    }}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: spacing.xs, paddingHorizontal: gutter, alignItems: "center" }}
      >
        {WORKSPACE_GROUPS.map((group) => {
          const isActive = activeGroup?.key === group.key;
          return (
            <Pressable
              key={group.key}
              testID={`workspace-group-${group.key}`}
              accessibilityRole="button"
              accessibilityLabel={group.label}
              accessibilityState={{ expanded: openGroup === group.key, selected: isActive }}
              hitSlop={layout.hitSlop}
              onPress={() => {
                setOpenGroup(group.members.length > 1 ? (openGroup === group.key ? null : group.key) : null);
                // Opens to the first member that actually exists, falling back
                // to the first entry when the whole group is still roadmap.
                if (group.members.length === 1) openMember(group.members[0]);
              }}
              style={({ pressed }: any) => ({
                // 36 with hitSlop rather than a 44 box: a 44px-tall pill row
                // reads as a second page header stacked above the real one.
                minHeight: 44,
                justifyContent: "center",
                paddingHorizontal: spacing.md,
                borderRadius: radius.sm,
                backgroundColor: isActive ? colors.brand : "transparent",
                opacity: pressed ? 0.85 : 1,
              })}
            >
              <Text
                numberOfLines={1}
                style={[type.titleSm, { color: isActive ? colors.onBrand : colors.onSurfaceSecondary }]}
              >
                {group.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {openGroup ? (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.xs, paddingHorizontal: gutter, alignItems: "center" }}
        >
          {WORKSPACE_GROUPS.find((g) => g.key === openGroup)!.members.map((member) => {
            const isActive = isActiveMember(member);
            return (
              <Pressable
                key={member.route}
                testID={`workspace-member-${member.label.toLowerCase().replace(/[^a-z]+/g, "-")}`}
                accessibilityRole="link"
                accessibilityState={{ selected: isActive }}
                accessibilityLabel={member.implemented ? member.label : `${member.label} — coming soon`}
                hitSlop={layout.hitSlop}
                onPress={() => openMember(member)}
                style={({ pressed }: any) => ({
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: spacing.md,
                  borderRadius: radius.sm,
                  borderWidth: StyleSheet.hairlineWidth,
                  borderColor: isActive ? colors.brandBorder : colors.border,
                  backgroundColor: isActive ? colors.brandTint : colors.surfaceSecondary,
                  flexDirection: "row",
                  alignItems: "center",
                  gap: spacing.s4,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text
                  numberOfLines={1}
                  style={[
                    type.bodySm,
                    {
                      color: isActive ? colors.brand
                        : member.implemented ? colors.onSurface
                        : colors.onSurfaceMuted,
                    },
                  ]}
                >
                  {member.label}
                </Text>
                {member.implemented ? null : (
                  <View style={{
                    paddingHorizontal: spacing.s4,
                    paddingVertical: 1,
                    borderRadius: radius.sm,
                    backgroundColor: colors.surfaceTertiary,
                  }}>
                    <Text style={{
                      fontSize: 9,
                      lineHeight: 12,
                      fontFamily: type.titleMd.fontFamily,
                      fontWeight: "700",
                      letterSpacing: 0.4,
                      color: colors.onSurfaceMuted,
                    }}>
                      SOON
                    </Text>
                  </View>
                )}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
    </View>
  );
}
