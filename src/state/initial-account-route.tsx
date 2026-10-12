import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { personalAccountPath } from "@/src/team-delegation";

// Imported by the web root before navigation initializes. With no floors the
// shell cannot mount its Slot yet; Expo can normalize the unresolved admin
// group to its default /access child and otherwise lose a personal deep link.
const initialRoute = typeof window === "undefined" ? undefined : (window as Window & { __FORGE_INITIAL_ROUTE__?: string }).__FORGE_INITIAL_ROUTE__;
const browserPath = initialRoute?.split('?')[0] || (typeof window === "undefined" ? undefined : window.location?.pathname);
const adminRoots = new Set(["access", "dashboard", "catalog", "customers", "quotations", "purchases", "purchases-completed", "purchase-orders", "payments", "payments-list", "walkins", "followups", "notebook", "tiles", "godown-stock", "sales-data", "team", "notifications", "reports"]);
const isAdminPath = (path: string) => path.startsWith('/') && !path.startsWith('//') && (adminRoots.has(path.split('/')[1]) || /^\/settings(?:-[a-z-]+)?$/.test(path));
const capturedPath = personalAccountPath(browserPath) || (browserPath && isAdminPath(browserPath)
  ? initialRoute || `${browserPath}${typeof window === "undefined" ? "" : window.location.search}` : null);
const PENDING_ROUTE_KEY = "forge.pending-initial-route";
const requestedAccountPath = (() => {
  if (typeof window === "undefined") return capturedPath;
  try {
    // A browser reload can happen while Expo has temporarily changed the URL
    // to /access but before the authorized destination has mounted.
    const pending = window.sessionStorage.getItem(PENDING_ROUTE_KEY);
    if (browserPath === "/access" && pending && isAdminPath(pending.split('?')[0])) return pending;
    if (capturedPath && browserPath !== "/access") window.sessionStorage.setItem(PENDING_ROUTE_KEY, capturedPath);
    return capturedPath;
  } catch { return capturedPath; }
})();
const InitialAccountRoute = createContext<{ path: string | null; finish: () => void }>({ path: null, finish: () => {} });

export function InitialAccountRouteProvider({ children }: { children: React.ReactNode }) {
  const [path, setPath] = useState(requestedAccountPath);
  const finish = useCallback(() => {
    if (typeof window !== "undefined") {
      try { window.sessionStorage.removeItem(PENDING_ROUTE_KEY); } catch { /* Storage may be unavailable. */ }
    }
    setPath(null);
  }, []);
  const value = useMemo(() => ({ path, finish }), [path, finish]);
  return <InitialAccountRoute.Provider value={value}>{children}</InitialAccountRoute.Provider>;
}

export function useInitialAccountRoute() {
  return useContext(InitialAccountRoute);
}
