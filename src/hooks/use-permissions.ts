// usePermissionMatrix — fetches the configurable per-role module-visibility
// matrix from GET /api/settings/permission-matrix. This is a UI-visibility
// helper only (see backend/routes/permissions_routes.py) — actual data
// authorization is unaffected and still fully enforced server-side by the
// existing RBAC on every endpoint. Cached in-memory for the process
// lifetime; call refresh() after saving an edit in the Permissions screen.
import { useCallback, useEffect, useState } from "react";

import { api } from "@/src/api/client";
import { useAuth } from "@/src/state/auth";
import { PROFILE_MODULES } from "@/src/access-profiles";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { GrantAction, hasGrantAccess } from "@/src/team-delegation";
import { KITCHEN_OWNER_ONLY } from "@/src/design/navigation";

const MODULE_GRANT_RESOURCE: Record<string, string> = {
  dashboard: "dashboard", quotations: "quotations", catalog: "catalog", customers: "customers",
  purchases: "purchases", payments: "payments", followups: "followups", notifications: "notifications",
  "godown-stock": "godown_stock",
  "furniture-quotations": "furniture_quotations", "payments-list": "payments",
  "kitchen-projects": "kitchen_projects",
  kitchen: "notebook_walkins", furniture: "notebook_walkins", "quotation-follow-up": "notebook_quotations",
  orders: "orders", tiles: "tiles", walkins: "walkins", reports: "reports",
  "sales-data": "sales_data",
};

export type ModuleInfo = { key: string; label: string };
export type MatrixRoleInfo = { role: string; label: string; level: number };
export type PermissionMatrixResponse = {
  modules: ModuleInfo[];
  roles: MatrixRoleInfo[];
  matrix: Record<string, Record<string, boolean>>;
  updated_at?: string | null;
  updated_by_name?: string | null;
};

let cache: PermissionMatrixResponse | null = null;
let inflight: Promise<PermissionMatrixResponse> | null = null;

async function fetchMatrix(force?: boolean): Promise<PermissionMatrixResponse> {
  if (cache && !force) return cache;
  if (!inflight) {
    inflight = api.get<PermissionMatrixResponse>("/settings/permission-matrix").then((res) => {
      cache = res;
      inflight = null;
      return res;
    }).catch((e) => {
      inflight = null;
      throw e;
    });
  }
  return inflight;
}

export function usePermissionMatrix() {
  const { loading: authLoading, staff } = useAuth();
  const [data, setData] = useState<PermissionMatrixResponse | null>(cache);
  const [loading, setLoading] = useState(!cache);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (force?: boolean) => {
    setLoading(true);
    try {
      const res = await fetchMatrix(force);
      setData(res);
      setError(null);
    } catch (e: any) {
      setError(e?.detail || "Could not load permissions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (!authLoading && staff) void load(); }, [authLoading, staff, load]);

  return { data, loading, error, refresh: () => load(true) };
}

/**
 * hasModuleAccess(moduleKey) — true unless the matrix has been loaded AND
 * explicitly says otherwise. Fails OPEN (visible) while loading or on error
 * so a slow/offline permissions fetch never hides navigation the role would
 * legitimately have — the real security boundary is the backend RBAC on
 * the underlying data endpoints, not this visibility check.
 */
export function useModuleAccess() {
  const { staff } = useAuth();
  const { data } = usePermissionMatrix();
  const { selectedFloorId } = useFloorAccess(!!staff);
  return useCallback(
    (moduleKey: string) => {
      if (moduleKey.startsWith("kitchen-")) moduleKey = "kitchen-projects";
      if (moduleKey === "dashboard" && staff) return true;
      if (moduleKey === "sales-data") return staff?.role === "owner";
      if (!staff) return true;
      if (staff.role === "owner") return true;
      if (moduleKey === "team") return false;
      if (staff.custom_access) {
        if (moduleKey === "settings") return true;
        const resource = MODULE_GRANT_RESOURCE[moduleKey];
        return Boolean(resource && hasGrantAccess(staff.access_grants, selectedFloorId, resource));
      }
      if (KITCHEN_OWNER_ONLY && moduleKey === "kitchen-projects") return false;
      if (!data) return true;
      const profileModules = staff.access_profile ? PROFILE_MODULES[staff.access_profile] : undefined;
      if (profileModules) return profileModules.has(moduleKey);
      const row = data.matrix[staff.role];
      if (!row || !(moduleKey in row)) return true;
      return row[moduleKey] !== false;
    },
    [staff, data, selectedFloorId],
  );
}

/** The API remains authoritative; this keeps unavailable actions out of the UI. */
export function useActionAccess(resource: string, action: GrantAction, legacyAllowed = true): boolean {
  const { staff } = useAuth();
  const { selectedFloorId } = useFloorAccess(!!staff);
  if (resource === "sales_data") return staff?.role === "owner";
  if (staff?.role === "owner") return true;
  if (!staff?.custom_access) return legacyAllowed;
  return hasGrantAccess(staff.access_grants, selectedFloorId, resource, action);
}
