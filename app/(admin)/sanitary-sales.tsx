import { Redirect } from "expo-router";

import { AdminPage } from "@/src/components/AdminPage";
import SanitarySalesDashboard from "@/src/components/sanitary-sales/SanitarySalesDashboard";
import { SANITARY_FLOOR_ID, floorLandingPath } from "@/src/constants/floors";
import { EmptyState } from "@/src/design/feedback";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";

export default function SanitarySalesRoute() {
  const { staff } = useAuth();
  const { selectedFloorId } = useFloorAccess(!!staff);

  if (!staff || !selectedFloorId) return null;
  if (selectedFloorId !== SANITARY_FLOOR_ID) {
    return <Redirect href={`/(admin)${floorLandingPath(selectedFloorId)}` as never} />;
  }
  if (staff.role !== "owner") {
    return <AdminPage title="Sanitary Sales Data">
      <EmptyState icon="lock" title="Owner access required" note="Sales Data is available only to the owner." />
    </AdminPage>;
  }
  return <SanitarySalesDashboard key={staff.id} />;
}
