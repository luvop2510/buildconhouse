import { Redirect, useLocalSearchParams } from "expo-router";

/** Retired notebook bookmarks use the shared, active-floor sales pages. */
export default function LegacyNotebookView() {
  const { view } = useLocalSearchParams<{ view?: string }>();
  return <Redirect href={view === "quotation" ? "/(admin)/followups" : "/(admin)/walkins"} />;
}
