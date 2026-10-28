import { useLocalSearchParams, Redirect } from "expo-router";
export default function Page() { const params=useLocalSearchParams(); return <Redirect href={{pathname:"/(admin)/sales-data/companies",params}}/>; }
