import { useEffect, useId, useRef, useState, type FocusEvent, type KeyboardEvent, type MouseEvent } from "react";
import { ActivityIndicator, Platform, Pressable, View } from "react-native";
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

const isWeb = Platform.OS === "web";

type DriverSearchResult = {
  query: string;
  drivers: SavedDispatchDriver[];
  failed: boolean;
};

/** Shared by the order, dispatch-board and transport-correction forms. */
export function DriverFields({ value, onChange, testPrefix = "tile-dispatch", disabled = false }: {
  value: DriverFieldsValue; onChange: (next: DriverFieldsValue) => void; testPrefix?: string; disabled?: boolean;
}) {
  const [search, setSearch] = useState("");
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [result, setResult] = useState<DriverSearchResult>();
  const [retry, setRetry] = useState(0);
  const [activeMobile, setActiveMobile] = useState<string>();
  const searchGroup = useRef<View>(null);
  const optionsList = useRef<View>(null);
  const listId = useId();
  const query = search.trim().toLowerCase();
  const current = result?.query === query ? result : undefined;
  const drivers = current?.drivers ?? [];
  const expanded = Boolean(query && !disabled && !dismissed && (!isWeb || focused));
  const hasOptions = expanded && drivers.length > 0;
  const activeOption = drivers.find(option => option.mobile === activeMobile);
  const optionId = (driver: SavedDispatchDriver) => `${listId}-${driver.mobile}`;

  useEffect(() => {
    if (!query || disabled || current || !expanded) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const { drivers: matches } = await tileOrdersApi.listDrivers(query, controller.signal);
        if (!controller.signal.aborted) setResult({ query, drivers: matches, failed: false });
      } catch {
        if (!controller.signal.aborted) setResult({ query, drivers: [], failed: true });
      }
    }, 90);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, retry, disabled, current, expanded]);

  useEffect(() => {
    if (!isWeb || !hasOptions) return;
    const input = document.activeElement;
    const node = searchGroup.current as unknown as HTMLElement | null;
    if (!input || !node?.contains(input)) return;
    const list = optionsList.current as unknown as HTMLElement | null;
    const option = list?.querySelector('[aria-selected="true"]');
    if (option && list && list.scrollHeight > list.clientHeight) {
      const row = option.getBoundingClientRect();
      const bounds = list.getBoundingClientRect();
      if (row.top < bounds.top) list.scrollTop += row.top - bounds.top;
      else if (row.bottom > bounds.bottom) list.scrollTop += row.bottom - bounds.bottom;
    }
    input.dispatchEvent(new Event("forge:reveal-focused-input", { bubbles: true }));
  }, [hasOptions, current, activeOption]);

  function changeSearch(text: string) {
    setSearch(text);
    setActiveMobile(undefined);
    setDismissed(false);
    if (!text.trim()) setResult(undefined);
  }

  function selectDriver(driver: SavedDispatchDriver) {
    onChange({ driver_name: driver.name, driver_mobile: driver.mobile, vehicle_number: driver.vehicle_number });
    changeSearch("");
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || !drivers.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const index = drivers.findIndex(driver => driver.mobile === activeMobile);
      const next = event.key === "ArrowDown"
        ? Math.min(index + 1, drivers.length - 1)
        : index < 0 ? drivers.length - 1 : Math.max(0, index - 1);
      setDismissed(false);
      setActiveMobile(drivers[next].mobile);
    } else if (event.key === "Enter" && hasOptions && activeOption) {
      event.preventDefault();
      selectDriver(activeOption);
    }
  }

  function handleKeyUp(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Escape" || !hasOptions) return;
    event.preventDefault();
    event.stopPropagation();
    setDismissed(true);
    setActiveMobile(undefined);
  }

  return <View style={{ gap: spacing.sm }}>
    <View ref={searchGroup} style={{ gap: spacing.sm }} {...(isWeb ? {
      dataSet: { revealFirstOption: "true" },
      onBlur: ((event: FocusEvent<HTMLElement>) => {
        if (event.currentTarget.contains(event.relatedTarget)) return;
        setFocused(false);
        setActiveMobile(undefined);
      }) as unknown as React.ComponentProps<typeof View>["onBlur"],
    } : {})}>
      <SearchField value={search} onChangeText={changeSearch} onClear={() => changeSearch("")}
        onFocus={() => { setFocused(true); setDismissed(false); }}
        editable={!disabled} autoComplete="off" autoCorrect={false}
        {...(isWeb ? {
          role: "combobox" as const, "aria-autocomplete": "list", "aria-expanded": hasOptions,
          "aria-controls": hasOptions ? listId : undefined,
          "aria-activedescendant": hasOptions && activeOption ? optionId(activeOption) : undefined,
          onKeyPress: handleKeyDown as unknown as React.ComponentProps<typeof SearchField>["onKeyPress"],
          onKeyUp: handleKeyUp,
        } : {})}
        placeholder="Search saved driver by name, mobile or vehicle" testID={`${testPrefix}-driver-search`} />
      {expanded && !current ? <ActivityIndicator accessibilityLabel="Searching saved drivers" color={colors.brand} /> : null}
      {expanded && current?.failed ? <Pressable accessibilityRole="button"
        onPress={() => { setResult(undefined); setRetry(value => value + 1); }}
        {...(isWeb ? { onMouseDown: (event: MouseEvent) => event.preventDefault() } : {})}
        style={{ minHeight: 44, justifyContent: "center" }}>
        <Text style={type.bodyMuted}>Drivers unavailable. Tap to retry, or enter details below.</Text>
      </Pressable> : null}
      {expanded && current && !current.failed && !drivers.length
        ? <Text accessibilityLiveRegion="polite" {...(isWeb ? { role: "status" as const } : {})} style={type.bodyMuted}>No saved drivers match.</Text> : null}
      {hasOptions ? <View ref={optionsList} nativeID={listId} accessibilityLabel="Saved drivers" style={{ gap: spacing.xs }}
        {...(isWeb ? { role: "listbox" as React.ComponentProps<typeof View>["role"], dataSet: { driverOptions: "true" } } : {})}>
        {drivers.map((driver, index) => <Pressable key={driver.mobile}
          testID={`${testPrefix}-driver-option-${driver.mobile}`}
          accessibilityRole={isWeb ? undefined : "button"}
          accessibilityLabel={`Use driver ${driver.name}, ${driver.mobile}`}
          {...(isWeb ? {
            nativeID: optionId(driver), role: "option" as const, tabIndex: -1 as const,
            "aria-selected": driver === activeOption,
            dataSet: { revealOption: (activeOption ? driver === activeOption : index === 0) ? "true" : "false" },
            onMouseDown: (event: MouseEvent) => event.preventDefault(),
          } : {})}
          onPress={() => selectDriver(driver)}
          style={({ pressed }) => ({ minHeight: 48, flexShrink: 0, padding: spacing.sm, borderRadius: radius.md,
            borderWidth: 1, borderColor: colors.border,
            backgroundColor: pressed || driver === activeOption ? colors.brandTint : colors.surfaceSecondary })}>
          <Text style={type.bodyStrong}>{driver.name}</Text>
          <Text style={type.caption}>{[driver.mobile, driver.vehicle_number].filter(Boolean).join(" · ")}</Text>
        </Pressable>)}
      </View> : null}
    </View>
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
