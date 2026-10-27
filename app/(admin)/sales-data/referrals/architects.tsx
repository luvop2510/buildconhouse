import { Redirect } from "expo-router";
export default function LegacyReferences() { return <Redirect href={{ pathname: "/(admin)/sales-data/relationships", params: { kind: "architect" } }} />; }
