import { Redirect } from "expo-router";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { floorLandingPath } from "@/src/constants/floors";

/** Keep old bookmarks within the selected workspace without loading retired alerts. */
export default function RetiredNotifications() {
  const { selectedFloorId } = useFloorAccess();
  return selectedFloorId ? <Redirect href={floorLandingPath(selectedFloorId) as any} /> : null;
}
