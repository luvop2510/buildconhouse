// Auth store. Single React context that any screen consumes.
// Supports staff + customer email/password login.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform } from "react-native";

import { clearBuilderDrafts, ensureBuilderDraftReset } from "@/src/components/quotation/helpers/draftStorage";
import { api, clearToken, getToken, getTokenKind, setToken, TokenKind } from "@/src/api/client";
import { getFloorAccess, getSelectedFloorId, resetFloorAccess, setSelectedFloorId } from "@/src/hooks/use-floor-access";
import type { AccessProfile, PersonalGrant } from "@/src/access-profiles";
import { ensureBackendReady } from "@/src/lib/backend-startup";

export type StaffUser = {
  id: string;
  email: string | null;
  phone?: string | null;
  mobile?: string | null;
  full_name: string;
  role: "owner" | "admin" | "manager" | "sales" | "purchase" | "warehouse" | "accounts" | "worker";
  active: boolean;
  avatar_url?: string | null;
  must_change_password?: boolean;
  mfa_enabled?: boolean;
  floor_ids: string[];
  access_profile?: AccessProfile | null;
  custom_access?: boolean;
  login_id?: string | null;
  team_role?: string | null;
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
  sessionError: string | null;
  retrySession: () => Promise<void>;
  kind: TokenKind | null;
  staff: StaffUser | null;
  customer: CustomerUser | null;
  loginStaff: (email: string, password: string, factor?: { mfa_code?: string; recovery_code?: string }) => Promise<void>;
  loginCustomer: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  markPasswordChanged: () => void;
};

// Owner access cannot be reduced by historical delegation fields. Staff
// passwords stay permanent even when an older response carries the flag.
function normalizeStaffIdentity(user: StaffUser): StaffUser {
  return {
    ...user, must_change_password: false,
    ...(user.role === "owner" ? { custom_access: false, access_profile: null, access_grants: undefined } : {}),
  };
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const automaticRetries = useRef(0);
  const [kind, setKind] = useState<TokenKind | null>(null);
  const [staff, setStaff] = useState<StaffUser | null>(null);
  const [customer, setCustomer] = useState<CustomerUser | null>(null);
  const operationGeneration = useRef(0);
  const credentialWrites = useRef<Promise<void>>(Promise.resolve());

  // A deletion already awaiting native storage must finish before a newer
  // login persists its credentials. Skip queued writes whose owner expired.
  const updateCredentials = useCallback((operation: number, write: () => Promise<void>) => {
    const pending = credentialWrites.current.catch(() => {}).then(async () => {
      if (operationGeneration.current === operation) await write();
    });
    credentialWrites.current = pending;
    return pending;
  }, []);

  const hydrate = useCallback(async (retryBackend = false) => {
    const operation = ++operationGeneration.current;
    const isCurrent = () => operationGeneration.current === operation;
    setLoading(true);
    try {
      await ensureBuilderDraftReset();
      if (!isCurrent()) return;
      // Restore a previously-stored session, if any.
      const k = await getTokenKind();
      if (!isCurrent()) return;
      const token = Platform.OS === "web" ? "cookie-session" : await getToken();
      if (!isCurrent()) return;
      if (!token || !k) {
        setSessionError(null);
        setStaff(null); setCustomer(null); setKind(null);
        return;
      }
      await ensureBackendReady({ retry: retryBackend });
      if (!isCurrent()) return;
      if (k === "staff") {
        const me = normalizeStaffIdentity(await api.get<StaffUser>("/auth/me"));
        if (!isCurrent()) return;
        if (me.custom_access) {
          const access = await api.get<{ grants: PersonalGrant[] }>("/settings/access-grants/me");
          if (!isCurrent()) return;
          me.access_grants = access.grants;
        }
        setKind(k); setStaff(me); setCustomer(null);
      } else {
        const me = await api.get<CustomerUser>("/auth/customer/me");
        if (!isCurrent()) return;
        setKind(k); setCustomer(me); setStaff(null);
      }
      automaticRetries.current = 0;
      setSessionError(null);
    } catch (error) {
      if (!isCurrent()) return;
      // A canceled request or temporary outage does not revoke a session.
      // In WebKit, unloading a document can reject its fetch before React
      // cleans up; clearing storage then would erase the next page’s session.
      const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
      const detail = error instanceof Error ? error.message : "";
      const accountForbidden = status === 403 && [
        "Not a staff token", "Not a customer token", "Portal access is disabled",
      ].includes(detail);
      if (status !== 401 && !accountForbidden) {
        // Keep credentials for retry, but never expose business screens before
        // identity AND personal grants have been authoritatively restored.
        setStaff(null); setCustomer(null); setKind(null);
        setSessionError("We couldn’t restore your session. Check your connection and try again.");
        return;
      }
      setSessionError(null);
      await clearBuilderDrafts();
      if (!isCurrent()) return;
      await updateCredentials(operation, clearToken);
      if (!isCurrent()) return;
      setStaff(null); setCustomer(null); setKind(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [updateCredentials]);

  useEffect(() => {
    // Wake in parallel with fonts/storage; public pages and login stay usable.
    void ensureBackendReady().catch(() => {});
    hydrate();
    return () => { operationGeneration.current += 1; };
  }, [hydrate]);

  useEffect(() => {
    if (!sessionError || loading) return;
    // Two short deploy/network retries; then keep the explicit recovery view.
    // Foreground/network events still recover a device that was offline.
    const timer = automaticRetries.current < 2
      ? setTimeout(() => { automaticRetries.current += 1; void hydrate(); }, automaticRetries.current === 0 ? 1000 : 3000)
      : undefined;
    const retry = () => { void hydrate(true); };
    const visible = () => { if (document.visibilityState === "visible") retry(); };
    const native = Platform.OS !== "web" ? AppState.addEventListener("change", state => { if (state === "active") retry(); }) : null;
    if (Platform.OS === "web" && typeof window !== "undefined") {
      window.addEventListener("online", retry);
      window.addEventListener("focus", retry);
      document.addEventListener("visibilitychange", visible);
    }
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      native?.remove();
      if (Platform.OS === "web" && typeof window !== "undefined") {
        window.removeEventListener("online", retry);
        window.removeEventListener("focus", retry);
        document.removeEventListener("visibilitychange", visible);
      }
    };
  }, [sessionError, loading, hydrate]);

  const loginStaff = useCallback(async (email: string, password: string, factor?: { mfa_code?: string; recovery_code?: string }) => {
    const operation = ++operationGeneration.current;
    const isCurrent = () => operationGeneration.current === operation;
    setLoading(true);
    setSessionError(null);
    automaticRetries.current = 0;
    try {
      await ensureBuilderDraftReset();
      if (!isCurrent()) return;
      await ensureBackendReady({ retry: true });
      if (!isCurrent()) return;
      const res = await api.post<{ access_token: string; user: StaffUser }>("/auth/login", { email, password, ...factor });
      if (!isCurrent()) return;
      await updateCredentials(operation, () => setToken(res.access_token, "staff"));
      if (!isCurrent()) return;
      res.user = normalizeStaffIdentity(res.user);
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
      // Owners/managers have implicit all-floor access, so their user document
      // may intentionally have no explicit floor_ids. Resolve the authoritative
      // visible list instead of leaving a prior user's floor selected.
      // Floor assignments and personal grants are independent account reads.
      // Start them together rather than adding two network round trips to login.
      // Publish the identity only when both are ready so delegation fails closed.
      const [savedFloor, assignedFloors, access] = await Promise.all([
        getSelectedFloorId(),
        getFloorAccess().then((value) => value.floor_ids).catch(() => res.user.floor_ids || []),
        res.user.custom_access
          ? api.get<{ grants: PersonalGrant[] }>("/settings/access-grants/me")
          : Promise.resolve(null),
      ]);
      if (!isCurrent()) return;
      const activeFloor = assignedFloors.includes(savedFloor) ? savedFloor : assignedFloors[0];
      if (activeFloor && activeFloor !== savedFloor) await setSelectedFloorId(activeFloor);
      if (!isCurrent()) return;
      if (access) res.user.access_grants = access.grants;
      setKind("staff"); setStaff(res.user); setCustomer(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [updateCredentials]);

  const loginCustomer = useCallback(async (email: string, password: string) => {
    const operation = ++operationGeneration.current;
    const isCurrent = () => operationGeneration.current === operation;
    setLoading(true);
    setSessionError(null);
    automaticRetries.current = 0;
    try {
      await ensureBuilderDraftReset();
      if (!isCurrent()) return;
      await ensureBackendReady({ retry: true });
      if (!isCurrent()) return;
      const res = await api.post<{ access_token: string; customer: CustomerUser }>("/auth/customer/login", { email, password });
      if (!isCurrent()) return;
      await updateCredentials(operation, () => setToken(res.access_token, "customer"));
      if (!isCurrent()) return;
      setKind("customer"); setCustomer(res.customer); setStaff(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [updateCredentials]);

  // Called right after the "set new password" screen succeeds — avoids a
  // full re-hydrate round trip, just clears the local force-change flag so
  // AuthGate lets the user through to their normal destination.
  const markPasswordChanged = useCallback(() => {
    setStaff((cur) => (cur ? { ...cur, must_change_password: false } : cur));
    setCustomer((cur) => (cur ? { ...cur, must_change_password: false } : cur));
  }, []);

  const logout = useCallback(async () => {
    const operation = ++operationGeneration.current;
    const isCurrent = () => operationGeneration.current === operation;
    setLoading(true);
    setSessionError(null);
    automaticRetries.current = 0;
    try {
      try { await api.post("/auth/logout"); } catch { /* best-effort */ }
      if (!isCurrent()) return;
      await clearBuilderDrafts();
      if (!isCurrent()) return;
      await updateCredentials(operation, clearToken);
      if (!isCurrent()) return;
      resetFloorAccess();
      setStaff(null); setCustomer(null); setKind(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [updateCredentials]);

  const value = useMemo(
    () => ({
      loading, sessionError, retrySession: () => hydrate(true), kind, staff, customer, loginStaff, loginCustomer, logout, markPasswordChanged,
    }),
    [loading, sessionError, hydrate, kind, staff, customer, loginStaff, loginCustomer, logout, markPasswordChanged],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
