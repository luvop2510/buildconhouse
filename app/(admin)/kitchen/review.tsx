import { Redirect } from "expo-router";
export default function KitchenLegacyPage() { return <Redirect href={"/kitchen/stages/lead?duplicate_review=pending" as any} />; }
