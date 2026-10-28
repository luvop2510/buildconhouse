import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { getSelectedFloorId } from "@/src/hooks/use-floor-access";
import { PERIOD_PRESETS, useSalesPeriod } from "./useSalesPeriod";
import { rangeLabel } from "./periodDates";

/** Keep a drilldown in the business unit and reporting period it came from. */
export function useAnalyticsDetailPeriod() {
  const params = useLocalSearchParams<{ preset?: string; floorId?: string; floor_id?: string; dateFrom?: string; dateTo?: string; date_from?: string; date_to?: string }>();
  const requestedFloor = params.floorId || params.floor_id;
  const [floor, setFloor] = useState(requestedFloor || "");
  useEffect(() => { if (requestedFloor) setFloor(requestedFloor); }, [requestedFloor]);
  useEffect(() => { if (!floor) void getSelectedFloorId().then(id => setFloor(id || "all")); }, [floor]);
  const { period } = useSalesPeriod(floor, false);
  if (!period) return { query: "", label: "Loading period…", period: null, floorId: floor };
  const preset = params.preset || period.preset;
  const query = new URLSearchParams({ preset });
  if (floor && floor !== "all" && floor !== "both") query.set("floor_id", floor);
  const from = params.dateFrom || params.date_from || (!params.preset ? period.dateFrom : null);
  const to = params.dateTo || params.date_to || (!params.preset ? period.dateTo : null);
  if (from) query.set("date_from", from);
  if (to) query.set("date_to", to);
  const label = from && to ? rangeLabel(from, to) : PERIOD_PRESETS.find(option => option.value === preset)?.label || period.label;
  return { query: query.toString(), label, period: { preset, dateFrom: from || null, dateTo: to || null, label }, floorId: floor };
}
