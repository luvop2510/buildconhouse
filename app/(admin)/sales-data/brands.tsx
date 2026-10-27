import { Redirect } from "expo-router";
export default function LegacyRanking() { return <Redirect href={{ pathname: "/(admin)/sales-data", params: { view: "brands" } }} />; }
