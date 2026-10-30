import { Redirect, Slot } from "expo-router";
import { View } from "react-native";

import { useAuth } from "@/src/state/auth";
import { AnalyticsNavigation } from "@/src/components/salesAnalytics/AnalyticsNavigation";
import { AdminPageCanvas, AdminPageScrollHeader } from "@/src/components/AdminPage";
import { useSalesTheme } from "@/src/components/salesAnalytics/salesTheme";
import { SalesScopeProvider } from "@/src/components/salesData/SalesScope";

/**
 * Shell shared by every Sales Data workspace. The switcher lives here so a
 * workspace never renders its own navigation and they cannot drift apart.
 */
export default function SalesDataLayout() {
  const { staff } = useAuth();
  const theme = useSalesTheme();
  if (!staff) return null;
  if (staff.role !== "owner") return <Redirect href="/(admin)/dashboard" />;
  return (
    <SalesScopeProvider><AdminPageCanvas.Provider value={theme.canvas}><AdminPageScrollHeader.Provider value={<AnalyticsNavigation />}>
      <View style={{ flex: 1, minHeight: 0 }}><Slot /></View>
    </AdminPageScrollHeader.Provider></AdminPageCanvas.Provider></SalesScopeProvider>
  );
}
