import { useLocalSearchParams, useRouter } from "expo-router";
import { AdminPage } from "@/src/components/AdminPage";
import { EmptyState } from "@/src/components/ds";
import { CustomerProfile } from "@/src/components/HomeCustomerSearch";

export default function UnifiedCustomerProfile() {
  const { kind, id, floorId } = useLocalSearchParams<{ kind?: string; id?: string; floorId?: string }>();
  const router = useRouter();
  return <AdminPage title="Customer profile" back={() => router.canGoBack() ? router.back() : router.replace("/(admin)/dashboard")}>
    {kind && id && floorId ? <CustomerProfile selected={{ kind, id, floor_id: floorId }} />
      : <EmptyState title="Choose a customer" subtitle="Open a customer from search or their current activity." />}
  </AdminPage>;
}
