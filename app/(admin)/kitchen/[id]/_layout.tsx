import { Slot, useLocalSearchParams } from "expo-router";
import { KitchenProjectProvider } from "@/src/components/kitchen/KitchenProjectState";
export default function KitchenProjectLayout() {
  const { id, returnTo } = useLocalSearchParams<{ id: string; returnTo?: string }>();
  return <KitchenProjectProvider key={id} id={id} returnTo={returnTo}><Slot /></KitchenProjectProvider>;
}
