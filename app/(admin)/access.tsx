import { useRouter } from "expo-router";
import { View } from "react-native";
import { AdminPage } from "@/src/components/AdminPage";
import { Button, EmptyState } from "@/src/components/ui";
import { useAuth } from "@/src/state/auth";
import { spacing } from "@/src/theme/tokens";

export default function NoPageAccess() {
  const { logout } = useAuth();
  const router = useRouter();
  return <AdminPage title="Page access" subtitle="Your team permissions">
    <View style={{ gap: spacing.lg }} testID="no-page-access">
      <EmptyState icon="lock" title="No pages enabled on this floor" subtitle="Switch to another assigned floor, or ask an owner to enable the pages you need. After permissions change, sign in again." />
      <Button label="Sign out" variant="secondary" onPress={async () => { await logout(); router.replace("/(auth)/login"); }} />
    </View>
  </AdminPage>;
}
