import { useSegments } from "expo-router";
import { useEffect, useState } from "react";
import { Platform } from "react-native";
import { useAuth } from "@/src/state/auth";

/** Hold leaf screen effects while its parent navigator retains browser history. */
export function StartupScreen({ children }: { children: React.ReactNode }) {
  const { loading, sessionError, kind } = useAuth();
  const segments = useSegments() as string[];
  const publicRoute = segments[0] === "privacy" || segments[0] === "terms";
  const authRoute = segments[0] === "(auth)";
  const protectedRoute = segments[0] === "(admin)" || segments[0] === "(customer)";
  const ready = Platform.OS !== "web" || publicRoute || authRoute || (!loading && !sessionError && (!protectedRoute || !!kind));
  const [opened, setOpened] = useState(false);
  useEffect(() => { if (ready) setOpened(true); }, [ready]);
  // After first admission, keep forms and their drafts mounted during recovery.
  return opened || ready ? <>{children}</> : null;
}
