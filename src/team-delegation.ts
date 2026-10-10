export type GrantAction = "view" | "create" | "update" | "delete" | "export";
export type DelegationFloor = { id: string; name: string };
export type DelegationResource = {
  key: string; label: string; actions: GrantAction[]; floor_ids: string[]; description?: string;
};
export type DelegationGrant = { resource: string; actions: GrantAction[]; floor_id: string };
export type DelegationState = { floorIds: string[]; grants: DelegationGrant[] };
export type DelegationCatalog = {
  resources: DelegationResource[];
  action_descriptions: Record<GrantAction, string>;
};

export const ACTION_LABELS: Record<GrantAction, string> = {
  view: "View", create: "Create", update: "Edit", delete: "Delete", export: "Export",
};
export const ACTION_ORDER: GrantAction[] = ["view", "create", "update", "delete", "export"];

export function toggleFloor(state: DelegationState, floorId: string, enabled: boolean): DelegationState {
  return {
    floorIds: enabled ? [...new Set([...state.floorIds, floorId])] : state.floorIds.filter((id) => id !== floorId),
    // Turning a floor back on starts with no pages: revocation is explicit.
    grants: enabled ? state.grants : state.grants.filter((grant) => grant.floor_id !== floorId),
  };
}

export function togglePage(state: DelegationState, floorId: string, resource: DelegationResource, enabled: boolean): DelegationState {
  if (!state.floorIds.includes(floorId) || !resource.floor_ids.includes(floorId)) return state;
  const grants = state.grants.filter((grant) => grant.floor_id !== floorId || grant.resource !== resource.key);
  return { ...state, grants: enabled ? [...grants, { floor_id: floorId, resource: resource.key, actions: ["view"] }] : grants };
}

export function toggleAction(state: DelegationState, floorId: string, resource: DelegationResource, action: GrantAction, enabled: boolean): DelegationState {
  if (action === "view" || !resource.actions.includes(action) || !state.floorIds.includes(floorId)) return state;
  return { ...state, grants: state.grants.map((grant) => {
    if (grant.floor_id !== floorId || grant.resource !== resource.key) return grant;
    const selected = enabled ? [...new Set([...grant.actions, "view" as const, action])] : grant.actions.filter((value) => value !== action);
    return { ...grant, actions: ACTION_ORDER.filter((value) => selected.includes(value)) };
  }) };
}

/** Expand historical all-floor grants, then keep only supported, enabled pages. */
export function loadDelegation(floorIds: string[], grants: { resource: string; actions: GrantAction[]; floor_id?: string | null }[], resources: DelegationResource[]): DelegationState {
  const selected: DelegationGrant[] = [];
  for (const resource of resources) {
    for (const floorId of [...new Set(floorIds)]) {
      if (!resource.floor_ids.includes(floorId)) continue;
      const matching = grants.filter((grant) => grant.resource === resource.key && (!grant.floor_id || grant.floor_id === floorId));
      const actions = ACTION_ORDER.filter((action) => resource.actions.includes(action) && matching.some((grant) => grant.actions.includes(action)));
      if (actions.length) selected.push({ resource: resource.key, floor_id: floorId, actions: [...new Set(["view" as const, ...actions])] });
    }
  }
  return { floorIds: [...new Set(floorIds)], grants: selected };
}

export function hasGrantAccess(grants: { resource: string; actions: string[]; floor_id?: string | null }[] | undefined, floorId: string, resource: string, action = "view"): boolean {
  if (!floorId) return false;
  return Boolean(grants?.some((grant) => grant.resource === resource && (!grant.floor_id || grant.floor_id === floorId) && grant.actions.includes(action)));
}

export function moduleForRoute(segments: string[]): string | null {
  if (segments.includes("access") || segments.some((part) => ["settings", "settings-password", "settings-mfa", "settings-privacy", "settings-terms"].includes(part))) return null;
  if (segments.includes("notebook")) {
    if (segments.includes("furniture-quotations")) return "furniture-quotations";
    if (segments.includes("quotation-follow-up") || segments.includes("quotation")) return "quotation-follow-up";
    if (segments.includes("kitchen")) return "kitchen";
    if (segments.includes("furniture")) return "furniture";
  }
  if (segments.includes("tiles")) return segments.includes("orders") ? "orders" : "tiles";
  for (const module of ["payments", "payments-list", "quotations", "catalog", "customers", "purchases", "godown-stock", "followups", "notifications", "walkins", "dashboard", "sales-data"]) {
    if (segments.includes(module)) return module;
  }
  if (segments.includes("purchases-completed") || segments.includes("purchase-orders")) return "purchases";
  if (segments.includes("reports")) return "sales-data";
  return "restricted";
}
