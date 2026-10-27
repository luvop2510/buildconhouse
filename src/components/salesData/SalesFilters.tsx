import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { MobileFilterSection } from "@/src/components/ds";
import { Button, TextField } from "@/src/components/ui";
import { useBp } from "@/src/design/responsive";
import { Sheet } from "@/src/design/components";
import { colors, spacing, type } from "@/src/theme/tokens";
import { customDateRange, inclusiveEndDay } from "./periodDates";
import { PERIOD_PRESETS, type SelectedPeriod } from "./useSalesPeriod";

export type FloorOption = { id: string; name: string };
export const FLOOR_LABEL: Record<string, string> = {
  "first-floor": "Sanitary", "ground-floor": "Tiles", "second-floor": "Kitchen", "third-floor": "Furniture",
};

/** The same two compact choices on every report and at every width. */
export function SalesFilters({ floors, floorId, onFloorChange, period, onPeriodChange }: {
  floors: FloorOption[]; floorId: string; onFloorChange: (id: string) => void;
  period: SelectedPeriod;
  onPeriodChange: (next: { preset: string; dateFrom?: string | null; dateTo?: string | null }) => void;
}) {
  const { isPhone } = useBp();
  const [picker, setPicker] = useState<"floor" | "period" | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [from, setFrom] = useState((period.dateFrom || "").slice(0, 10));
  const [to, setTo] = useState(inclusiveEndDay(period.dateTo));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setFrom((period.dateFrom || "").slice(0, 10)); setTo(inclusiveEndDay(period.dateTo)); }, [period.dateFrom, period.dateTo]);
  const floorOptions = [{ value: "all", label: "All units" }, ...floors.map(f => ({ value: f.id, label: FLOOR_LABEL[f.id] || f.name }))];
  const floorLabel = floorOptions.find(f => f.value === floorId)?.label || "Choose unit";
  const applyCustom = () => {
    const range = customDateRange(from.trim(), to.trim());
    if (!range) { setError("Enter valid dates as YYYY-MM-DD, with the end on or after the start."); return; }
    setError(null); setShowCustom(false); onPeriodChange({ preset: "custom", ...range });
  };
  return <MobileFilterSection initiallyExpanded={!isPhone} testID="sales-data-filters" style={{ gap: spacing.s8 }}>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.s8, alignItems: "flex-end" }}>
      <View style={{ gap: spacing.s4, flexGrow: 1, flexBasis: 120, minWidth: 0 }}>
        <Text style={type.caption}>Business unit</Text>
        <Button testID="sales-data-floor-picker" label={floorLabel} iconRight="chevron-down" variant="secondary" fullWidth onPress={() => setPicker("floor")} />
      </View>
      <View testID="sales-data-preset" style={{ gap: spacing.s4, flexGrow: 1, flexBasis: 140, minWidth: 0 }}>
        <Text style={type.caption}>Sales period · UTC</Text>
        <Button testID="sales-data-period-picker" label={period.label} iconRight="chevron-down" variant="secondary" fullWidth onPress={() => setPicker("period")} />
      </View>
    </View>
    <Sheet open={picker !== null} onClose={() => setPicker(null)} title={picker === "floor" ? "Business unit" : "Reporting period"}>
      <View style={{ gap: spacing.s4 }}>
        {(picker === "floor" ? floorOptions : [...PERIOD_PRESETS, { value: "custom", label: "Custom range" }]).map(option => <Pressable
          key={option.value} testID={`sales-data-${picker}-${option.value}`}
          accessibilityRole="button" accessibilityLabel={option.label}
          accessibilityState={{ checked: option.value === (picker === "floor" ? floorId : period.preset) }}
          onPress={() => {
            if (picker === "floor") onFloorChange(option.value);
            else if (option.value === "custom") setShowCustom(true);
            else { setShowCustom(false); setError(null); onPeriodChange({ preset: option.value }); }
            setPicker(null);
          }}
          style={({ pressed }) => ({ minHeight: 48, paddingHorizontal: spacing.s12, paddingVertical: spacing.s12, justifyContent: "center", backgroundColor: pressed || option.value === (picker === "floor" ? floorId : period.preset) ? colors.surfaceTertiary : "transparent" })}
        ><Text style={type.body}>{option.label}</Text></Pressable>)}
      </View>
    </Sheet>
    {showCustom ? <View testID="sales-data-custom-range" style={{ gap: spacing.s12 }}>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.s12 }}>
        <TextField placeholderTextColor={colors.onSurfaceMuted} label="From" value={from} onChangeText={setFrom} placeholder="YYYY-MM-DD" autoCapitalize="none" containerStyle={{ flex: 1, minWidth: 120 }} />
        <TextField placeholderTextColor={colors.onSurfaceMuted} label="To" value={to} onChangeText={setTo} placeholder="YYYY-MM-DD" autoCapitalize="none" containerStyle={{ flex: 1, minWidth: 120 }} />
      </View>
      {error ? <Text accessibilityRole="alert" style={[type.bodySm, { color: colors.error }]}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.s8 }}>
        <Button label="Apply range" onPress={applyCustom} />
        <Button label="Cancel" variant="secondary" onPress={() => { setShowCustom(false); setError(null); }} />
      </View>
    </View> : null}
  </MobileFilterSection>;
}
