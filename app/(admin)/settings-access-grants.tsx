import { Redirect } from "expo-router";

/** A single editor keeps floor, page and action changes in one saved draft. */
export default function SettingsAccessGrants() {
  return <Redirect href="/(admin)/team" />;
}
