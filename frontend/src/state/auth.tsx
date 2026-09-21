// Auth store. Single React context that any screen consumes.
// Supports staff + customer email/password login.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Platform } from "react-native";

import { clearBuilderDrafts } from "@/src/components/quotation/helpers/draftStorage";
import { api, clearToken, getToken, getTokenKind, setToken, TokenKind } from "@/src/api/client";
import { getFloorAccess, getSelectedFloorId, resetFloorAccess, setSelectedFloorId } from "@/src/hooks/use-floor-access";
import type { AccessProfile, PersonalGrant } from "@/src/access-profiles";

export type StaffUser = {
  id: string;
  email: string;
  full_name: string;
  role: "owner" | "admin" | "manager" | "sales" | "purchase" | "warehouse" | "accounts" | "worker";
  active: boolean;
  avatar_url?: string | null;
  must_change_password?: boolean;
  floor_ids: string[];
  access_profile?: AccessProfile | null;
  custom_access?: boolean;
  access_grants?: PersonalGrant[];
};

export type CustomerUser = {
  id: string;
  email: string;
  name: string;
  company?: string | null;
  tier: "retail" | "trade" | "vip";
  avatar_url?: string | null;
  portal_enabled?: boolean;
  must_change_password?: boolean;
};

type AuthState = {
  loading: boolean;
  kind: TokenKind | null;
  staff: StaffUser | null;
  customer: CustomerUser | null;
  loginStaff: (email: string, password: string) => Promise<void>;
  loginCustomer: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  markPasswordChanged: () => void;
};

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [kind, setKind] = useState<TokenKind | null>(null);
  const [staff, setStaff] = useState<StaffUser | null>(null);
  const [customer, setCustomer] = useState<CustomerUser | null>(null);

  const hydrate = useCallback(async () => {
    try {
      // Restore a previously-stored session, if any.
      const k = await getTokenKind();
      const token = Platform.OS === "web" ? "cookie-session" : await getToken();
      if (!token || !k) {
        setStaff(null); setCustomer(null); setKind(null);
        return;
      }
      setKind(k);
      if (k === "staff") {
        const me = await api.get<StaffUser>("/auth/me");
        if (me.custom_access) {
          const access = await api.get<{ grants: PersonalGrant[] }>("/settings/access-grants/me");
          me.access_grants = access.grants;
        }
        setStaff(me);
      } else {
        const me = await api.get<CustomerUser>("/auth/customer/me");
        setCustomer(me);
      }
    } catch {
      await clearBuilderDrafts();
      await clearToken();
      setStaff(null); setCustomer(null); setKind(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { hydrate(); }, [hydrate]);

  const loginStaff = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ access_token: string; user: StaffUser }>("/auth/login", { email, password });
    await setToken(res.access_token, "staff");
    // Floor access is identity-scoped, not app-scoped. In particular, a
    // single-floor worker's cached response must never determine what the
    // next owner sees in the shell.
    resetFloorAccess();
    // Pin an active floor BEFORE any screen mounts. The previous guard only
    // replaced an empty selection, so a floor persisted by a prior user (or
    // a prior business unit) survived logout and every scoped request from
    // the newly signed-in worker was rejected with "You do not have access
    // to this floor". Keep a saved selection only when this account can use
    // it; otherwise fall back to the first floor assigned to the account.
    const savedFloor = await getSelectedFloorId();
    // Owners/managers have implicit all-floor access, so their user document
    // may intentionally have no explicit floor_ids. Resolve the authoritative
    // visible list instead of leaving a prior user's floor selected.
    let assignedFloors = res.user.floor_ids || [];
    try {
      assignedFloors = (await getFloorAccess()).floor_ids;
    } catch {
      // Authentication must remain usable during a transient floor-settings
      // outage; the shell will retry its normal access request after login.
    }
    const activeFloor = assignedFloors.includes(savedFloor) ? savedFloor : assignedFloors[0];
    if (activeFloor && activeFloor !== savedFloor) await setSelectedFloorId(activeFloor);
    if (res.user.custom_access) {
      const access = await api.get<{ grants: PersonalGrant[] }>("/settings/access-grants/me");
      res.user.access_grants = access.grants;
    }
    setKind("staff"); setStaff(res.user); setCustomer(null);
  }, []);

  const loginCustomer = useCallback(async (email: string, password: string) => {
    const res = await api.post<{ access_token: string; customer: CustomerUser }>("/auth/customer/login", { email, password });
    await setToken(res.access_token, "customer");
    setKind("customer"); setCustomer(res.customer); setStaff(null);
  }, []);

  // Called right after the "set new password" screen succeeds — avoids a
  // full re-hydrate round trip, just clears the local force-change flag so
  // AuthGate lets the user through to their normal destination.
  const markPasswordChanged = useCallback(() => {
    setStaff((cur) => (cur ? { ...cur, must_change_password: false } : cur));
    setCustomer((cur) => (cur ? { ...cur, must_change_password: false } : cur));
  }, []);

  const logout = useCallback(async () => {
    try { await api.post("/auth/logout"); } catch { /* best-effort */ }
    await clearBuilderDrafts();
    await clearToken();
    resetFloorAccess();
    setStaff(null); setCustomer(null); setKind(null);
  }, []);

  const value = useMemo(
    () => ({
      loading, kind, staff, customer, loginStaff, loginCustomer, logout, markPasswordChanged,
    }),
    [loading, kind, staff, customer, loginStaff, loginCustomer, logout, markPasswordChanged],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
