import { useSegments } from "expo-router";
import { useEffect, useState } from "react";
import { useAuth } from "@/src/state/auth";

/** Hold initial screen effects while retaining the root navigator/deep link. */
function StartupScreen({ children }: { children: React.ReactNode }) {
  const { loading, sessionError, kind } = useAuth();
  const segments = useSegments() as string[];
  const publicRoute = segments[0] === "privacy" || segments[0] === "terms";
  const authRoute = segments[0] === "(auth)";
  const protectedRoute = segments[0] === "(admin)" || segments[0] === "(customer)";
  const ready = publicRoute || authRoute || (!loading && !sessionError && (!protectedRoute || !!kind));
  const [opened, setOpened] = useState(false);
  useEffect(() => { if (ready) setOpened(true); }, [ready]);
  // After first admission, keep forms and their drafts mounted during recovery.
  return opened || ready ? <>{children}</> : null;
}

export const startupScreenLayout = ({ children }: { children: React.ReactNode }) => <StartupScreen>{children}</StartupScreen>;
