import { useLocalSearchParams } from "expo-router";
import { LazyKitchenWorkspace } from "@/src/components/kitchen/LazyKitchenWorkspace";
import { KitchenFloor } from "@/src/components/kitchen/shared";
import { AdminPage } from "@/src/components/AdminPage";
import { ErrorState } from "@/src/components/ds";
import { KITCHEN_STAGES } from "@/src/api/kitchenProjects";
export default function KitchenStageQueue() {
  const { stage } = useLocalSearchParams<{ stage: string }>();
  const selected = KITCHEN_STAGES.find(value => value === stage);
  return selected ? <LazyKitchenWorkspace page="stage" stage={selected} /> : <KitchenFloor><AdminPage title="Kitchen"><ErrorState title="Stage unavailable" subtitle="Choose one of the nine Kitchen stages." /></AdminPage></KitchenFloor>;
}
