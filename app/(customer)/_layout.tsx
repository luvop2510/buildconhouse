import { Stack } from "expo-router";

import { MobileViewport } from "@/src/components/mobile/MobileShell";
import { CustomerPageBoundary } from "@/src/components/PageErrorBoundary";
import { colors } from "@/src/theme/tokens";

const pageScreenLayout = ({ children }: { children: React.ReactNode }) => <CustomerPageBoundary>{children}</CustomerPageBoundary>;

export default function CustomerLayout() {
  return (
    <MobileViewport
      testID="customer-mobile-shell"
      backgroundColor={colors.surface}
      edges={["left", "right"]}
    >
      <Stack screenOptions={{ headerShown: false }} screenLayout={pageScreenLayout} />
    </MobileViewport>
  );
}
