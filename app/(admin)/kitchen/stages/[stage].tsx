import { useLocalSearchParams } from "expo-router";
import { KitchenWorkspace } from "@/src/components/kitchen/KitchenWorkspace";
import { KitchenFloor } from "@/src/components/kitchen/shared";
import { AdminPage } from "@/src/components/AdminPage";
import { ErrorState } from "@/src/components/ds";
import { KITCHEN_STAGES } from "@/src/api/kitchenProjects";
export default function KitchenStageQueue() {
  const { stage } = useLocalSearchParams<{ stage: string }>();
  const selected = KITCHEN_STAGES.find(value => value === stage);
  return selected ? <KitchenWorkspace page="stage" stage={selected} /> : <KitchenFloor><AdminPage title="Kitchen"><ErrorState title="Stage unavailable" subtitle="Choose one of the nine Kitchen stages." /></AdminPage></KitchenFloor>;
}
