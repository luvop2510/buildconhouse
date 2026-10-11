import { Redirect } from "expo-router";

/** Historical role-matrix links now use the unified floor/page/action editor. */
export default function SettingsPermissions() {
  return <Redirect href="/(admin)/team" />;
}
