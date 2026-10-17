import { Redirect } from "expo-router";

/** Retired department workspace: retain bookmarks within the active floor. */
export default function LegacyDepartmentWorkspace() {
  return <Redirect href="/(admin)/walkins" />;
}
