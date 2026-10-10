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

const MODULE_GRANT_RESOURCE: Record<string, string> = {
  dashboard: "dashboard", quotations: "quotations", catalog: "catalog", customers: "customers",
  purchases: "purchases", payments: "payments", followups: "followups", notifications: "notifications",
  "godown-stock": "godown_stock",
  "furniture-quotations": "quotations", "payments-list": "payments",
  kitchen: "walkins", furniture: "walkins", "quotation-follow-up": "followups",
  orders: "orders", tiles: "tiles", walkins: "walkins", reports: "reports",
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

  useEffect(() => { load(); }, [load]);

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
  return useCallback(
    (moduleKey: string) => {
      if (!staff) return true;
      if (staff.custom_access) {
        const resource = MODULE_GRANT_RESOURCE[moduleKey];
        return Boolean(resource && staff.access_grants?.some((grant) => grant.resource === resource && grant.actions.includes("view")));
      }
      if (!data) return true;
      const profileModules = staff.access_profile ? PROFILE_MODULES[staff.access_profile] : undefined;
      if (profileModules) return profileModules.has(moduleKey);
      const row = data.matrix[staff.role];
      if (!row || !(moduleKey in row)) return true;
      return row[moduleKey] !== false;
    },
    [staff, data],
  );
}
