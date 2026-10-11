import { Redirect, useLocalSearchParams } from "expo-router";

/** Keep old bookmarks on the current brand analytics page. */
export default function LegacyBrandDetail() {
  const params = useLocalSearchParams<{ id: string }>();
  return <Redirect href={{ pathname: "/(admin)/sales-data/brands/[id]", params } as any} />;
}
