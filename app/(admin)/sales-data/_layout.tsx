import { Slot } from "expo-router";
import { View } from "react-native";

import { AnalyticsNavigation } from "@/src/components/salesAnalytics/AnalyticsNavigation";
import { SalesScopeProvider } from "@/src/components/salesData/SalesScope";

/**
 * Shell shared by every Sales Data workspace. The switcher lives here so a
 * workspace never renders its own navigation and they cannot drift apart.
 */
export default function SalesDataLayout() {
  return (
    // No gap: the switcher now owns its own vertical padding and closes with
    // a hairline rule, so an extra gap here would float that rule in dead
    // space instead of seating it against the page below.
    <SalesScopeProvider><View style={{ flex: 1, minHeight: 0 }}>
      <AnalyticsNavigation />
      <View style={{ flex: 1, minHeight: 0 }}>
        <Slot />
      </View>
    </View></SalesScopeProvider>
  );
}
