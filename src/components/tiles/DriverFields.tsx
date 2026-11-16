import { useEffect, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SearchField, TextField } from "@/src/components/ui";
import { tileOrdersApi, type SavedDispatchDriver } from "@/src/api/tileOrders";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

export type DriverFieldsValue = { driver_name: string; driver_mobile: string; vehicle_number: string };

export function validateDriverFields(value: DriverFieldsValue) {
  const mobile = value.driver_mobile.trim();
  if (!mobile) return;
  let digits = mobile.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  if (/[^\d\s()+-]/.test(mobile) || digits.length !== 10) throw new Error("Enter a 10 digit driver mobile number");
  if (!value.driver_name.trim()) throw new Error("Enter the driver's name to save their mobile number");
}

/** Shared by the order, dispatch-board and transport-correction forms. */
export function DriverFields({ value, onChange, testPrefix = "tile-dispatch", disabled = false }: {
  value: DriverFieldsValue; onChange: (next: DriverFieldsValue) => void; testPrefix?: string; disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [drivers, setDrivers] = useState<SavedDispatchDriver[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setDrivers([]);
    setFailed(false);
    setLoading(false);
    if (search.trim().length < 2) return () => { current = false; controller.abort(); };
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        const result = await tileOrdersApi.listDrivers(search.trim(), controller.signal);
        if (current) setDrivers(result.drivers);
      } catch {
        if (current && !controller.signal.aborted) setFailed(true);
      } finally {
        if (current) setLoading(false);
      }
    }, 250);
    return () => { current = false; clearTimeout(timer); controller.abort(); };
  }, [search, retry]);

  return <View style={{ gap: spacing.sm }}>
    <SearchField value={search} onChangeText={setSearch} onClear={() => setSearch("")}
      placeholder="Search saved driver by name, mobile or vehicle" testID={`${testPrefix}-driver-search`} />
    {loading ? <ActivityIndicator accessibilityLabel="Searching saved drivers" color={colors.brand} /> : null}
    {failed ? <Pressable accessibilityRole="button" onPress={() => setRetry((n) => n + 1)} style={{ minHeight: 44, justifyContent: "center" }}>
      <Text style={type.bodyMuted}>Drivers unavailable. Tap to retry, or enter details below.</Text>
    </Pressable> : null}
    {drivers.map((driver) => <Pressable key={driver.mobile} disabled={disabled}
      testID={`${testPrefix}-driver-option-${driver.mobile}`} accessibilityRole="button"
      accessibilityLabel={`Use driver ${driver.name}, ${driver.mobile}`}
      onPress={() => { onChange({ driver_name: driver.name, driver_mobile: driver.mobile, vehicle_number: driver.vehicle_number }); setSearch(""); }}
      style={{ minHeight: 48, padding: spacing.sm, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border }}>
      <Text style={type.bodyStrong}>{driver.name}</Text>
      <Text style={type.caption}>{[driver.mobile, driver.vehicle_number].filter(Boolean).join(" · ")}</Text>
    </Pressable>)}
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      {([ ["driver_name", "Driver name"], ["driver_mobile", "Driver mobile"], ["vehicle_number", "Vehicle number"] ] as const).map(([key, label]) => (
        <TextField key={key} testID={`${testPrefix}-${key.replace(/_/g, "-")}`} label={label}
          value={value[key]} onChangeText={(text) => onChange({ ...value, [key]: text })}
          editable={!disabled} keyboardType={key === "driver_mobile" ? "phone-pad" : "default"}
          placeholder={key === "driver_mobile" ? "10 digit mobile (optional)" : label}
          containerStyle={{ flex: 1, minWidth: 150 }} />
      ))}
    </View>
    <Text style={type.caption}>Enter a mobile to save this driver for future dispatches. Changes apply when you confirm.</Text>
  </View>;
}
