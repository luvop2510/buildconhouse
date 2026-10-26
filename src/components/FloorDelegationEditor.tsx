import { StyleSheet, Switch, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { ACTION_LABELS, ACTION_ORDER, DelegationCatalog, DelegationFloor, DelegationState, toggleAction, toggleFloor, togglePage, delegationPagesForFloor, isResourceAssignable, delegationPageLabels } from "@/src/team-delegation";
import { NAVIGATION } from "@/src/design/navigation";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

export function FloorDelegationEditor({ floors, catalog, value, onChange, disabled = false }: {
  floors: DelegationFloor[]; catalog: DelegationCatalog; value: DelegationState;
  onChange: (value: DelegationState) => void; disabled?: boolean;
}) {
  return <View style={{ gap: spacing.md }} testID="floor-delegation-editor">
    <View style={{ gap: spacing.xs }}>
      <Text style={type.label}>Floors and pages</Text>
      <Text style={type.caption}>Turn on a floor to see its pages. Turn on any pages, then choose what this person can do. All changes are saved together.</Text>
      <Text style={type.caption} testID="delegation-summary">{value.floorIds.length} floors · {value.grants.length} pages enabled</Text>
      {value.grants.length === 0 ? <Text style={type.caption}>No page access. This person can sign in but cannot open business pages until you enable them.</Text> : null}
    </View>
    {floors.map((floor) => {
      const enabled = value.floorIds.includes(floor.id);
      const pages = delegationPagesForFloor(catalog.resources, value.grants, floor.id);
      const count = value.grants.filter((grant) => grant.floor_id === floor.id).length;
      return <View key={floor.id} style={styles.floor} testID={`delegation-floor-${floor.id}`}>
        <View style={styles.row}>
          <View style={styles.copy}>
            <Text style={type.bodyStrong}>{floor.name}</Text>
            <Text style={type.caption}>{enabled ? `${count} of ${pages.length} pages enabled` : "Off · no access to this floor"}</Text>
          </View>
          <Switch testID={`floor-toggle-${floor.id}`} accessibilityLabel={`Allow ${floor.name}`} value={enabled} disabled={disabled} onValueChange={(next) => onChange(toggleFloor(value, floor.id, next))} />
        </View>
        {enabled ? <View style={styles.pages} testID={`floor-pages-${floor.id}`}>
          {pages.length === 0 ? <Text style={type.caption}>No assignable pages are available for this floor.</Text> : pages.map((resource) => {
            const grant = value.grants.find((item) => item.floor_id === floor.id && item.resource === resource.key);
            const currentPageLabels = delegationPageLabels(resource.key, floor.id, NAVIGATION);
            const legacy = !isResourceAssignable(resource, floor.id);
            return <View key={resource.key} style={styles.page}>
              <View style={styles.row}>
                <View style={styles.copy}>
                  <Text style={type.bodyStrong}>{resource.key === "kitchen_projects" ? "Kitchen workspace" : resource.label}{legacy ? " · Legacy access" : ""}</Text>
                  {resource.key === "kitchen_projects" ? <>
                    <Text style={type.caption}>Includes {currentPageLabels.join(" · ")}</Text>
                    <Text style={type.caption}>These pages share workspace access. Updated workflow pages keep the selected permissions.</Text>
                  </> : null}
                  {resource.key !== "kitchen_projects" && currentPageLabels.length ? <Text style={type.caption}>Pages: {currentPageLabels.join(" · ")}</Text> : null}
                  {legacy ? <Text style={type.caption}>Existing access is preserved. This page is no longer available for new delegation on this floor; turn it off to revoke it.</Text> : null}
                  {resource.description ? <Text style={type.caption}>{resource.description}</Text> : null}
                  <Text style={type.caption}>{grant ? `Can: ${grant.actions.map((action) => ACTION_LABELS[action]).join(", ")}` : "Off · no access to this page"}</Text>
                </View>
                <Switch testID={`page-toggle-${floor.id}-${resource.key}`} accessibilityLabel={`Allow ${resource.label} on ${floor.name}`} value={!!grant} disabled={disabled || (legacy && !grant)} onValueChange={(next) => onChange(togglePage(value, floor.id, resource, next))} />
              </View>
              {grant ? <View style={styles.actions}>
                {ACTION_ORDER.filter((action) => resource.actions.includes(action)).map((action) => <View key={action} style={styles.row}>
                  <View style={styles.copy}>
                    <Text style={type.label}>{ACTION_LABELS[action]}{action === "view" ? " · included" : ""}</Text>
                    <Text style={type.caption}>{catalog.action_descriptions[action]}</Text>
                  </View>
                  <Switch testID={`action-toggle-${floor.id}-${resource.key}-${action}`} accessibilityLabel={`${ACTION_LABELS[action]} ${resource.label} on ${floor.name}`} value={grant.actions.includes(action)} disabled={disabled || legacy || action === "view"} onValueChange={(next) => onChange(toggleAction(value, floor.id, resource, action, next))} />
                </View>)}
              </View> : null}
            </View>;
          })}
          <Text style={type.caption}>Turning off {floor.name} removes all its page permissions. Turning it on again starts with every page off.</Text>
        </View> : null}
      </View>;
    })}
  </View>;
}

const styles = StyleSheet.create({
  floor: { backgroundColor: colors.surfaceSecondary, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border, padding: spacing.md, gap: spacing.md },
  row: { flexDirection: "row", alignItems: "center", gap: spacing.sm, minHeight: 44 },
  copy: { flex: 1, minWidth: 0, gap: 3 },
  pages: { gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider, paddingTop: spacing.md },
  page: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.sm, gap: spacing.sm },
  actions: { gap: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider, paddingTop: spacing.sm },
});
