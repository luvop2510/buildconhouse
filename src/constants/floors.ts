// frontend/src/constants/floors.ts
// Canonical floor identifiers. Mirrors backend/services/floor_scope.py's
// DEFAULT_FLOORS and backend/auth.py's TILES_FLOOR_ID — these ids are the
// values stored in every scoped document's `floor_id` and sent as the
// `X-Floor-Id` request header (src/api/client.ts).
//
// Screens that belong to exactly one business unit must pin their requests
// to that unit's id rather than inheriting the global floor switcher's
// current selection: inheriting it is what let Tile Orders show Sanitary
// Bathroom records (and vice versa) whenever the selection was stale or
// unset.
export const TILES_FLOOR_ID = "ground-floor";
export const SANITARY_FLOOR_ID = "first-floor";
export const KITCHEN_FLOOR_ID = "second-floor";
export const FURNITURE_FLOOR_ID = "third-floor";
export const NOTEBOOK_FLOOR_LABELS: Record<string, string> = {
  [KITCHEN_FLOOR_ID]: "Kitchen Floor",
  [FURNITURE_FLOOR_ID]: "Furniture Floor",
};

// User-facing names must not depend on the seed data's legacy floor names
// (the kitchen record is still stored under the historical `second-floor`
// slug). Keep ids stable for API isolation, but normalize labels everywhere in
// the shell and notebook UI.
export const FLOOR_DISPLAY_LABELS: Record<string, string> = {
  [TILES_FLOOR_ID]: "Ground Floor",
  [SANITARY_FLOOR_ID]: "The Sanitary Bathroom",
  ...NOTEBOOK_FLOOR_LABELS,
};

export function floorDisplayLabel(floor: { id?: string; slug?: string; name?: string }): string {
  return FLOOR_DISPLAY_LABELS[floor.id || floor.slug || ""] || floor.name || floor.slug || floor.id || "Floor";
}

export function floorLandingPath(floorId: string): string {
  if (floorId === TILES_FLOOR_ID) return "/tiles";
  if (floorId === KITCHEN_FLOOR_ID) return "/walkins";
  if (floorId === FURNITURE_FLOOR_ID) return "/walkins";
  return "/dashboard";
}
