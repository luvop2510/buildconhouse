import { createContext, useCallback, useContext, useMemo, useState } from "react";

import { personalAccountPath } from "@/src/team-delegation";

// Imported by the web root before navigation initializes. With no floors the
// shell cannot mount its Slot yet; Expo can normalize the unresolved admin
// group to its default /access child and otherwise lose a personal deep link.
const requestedAccountPath = personalAccountPath(typeof window === "undefined" ? undefined : window.location?.pathname);
const InitialAccountRoute = createContext<{ path: string | null; finish: () => void }>({ path: null, finish: () => {} });

export function InitialAccountRouteProvider({ children }: { children: React.ReactNode }) {
  const [path, setPath] = useState(requestedAccountPath);
  const finish = useCallback(() => setPath(null), []);
  const value = useMemo(() => ({ path, finish }), [path, finish]);
  return <InitialAccountRoute.Provider value={value}>{children}</InitialAccountRoute.Provider>;
}

export function useInitialAccountRoute() {
  return useContext(InitialAccountRoute);
}
