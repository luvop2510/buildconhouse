import { createElement, useEffect, useId, useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import { Text } from "@/src/components/AppText";
import { KitchenTextField as TextField, kitchenColors as colors, kitchenType as type } from "./KitchenPrimitives";
import { Menu } from "@/src/design/navigationControls";
import { radius, spacing } from "@/src/theme/tokens";
import { kitchenToday } from "./KitchenDates";

/** A real disabled control; pointer, keyboard and accessibility state agree. */
export function KitchenOption({ label, accessibilityLabel, active, disabled, onPress, testID }: { label: string; accessibilityLabel?: string; active?: boolean; disabled?: boolean; onPress: () => void; testID?: string }) {
  const [focused, setFocused] = useState(false);
  return <Pressable onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} accessibilityRole="button" accessibilityLabel={accessibilityLabel || label} accessibilityState={{ disabled: Boolean(disabled), selected: Boolean(active) }} aria-pressed={Boolean(active)} disabled={disabled} tabIndex={disabled ? -1 : 0} onPress={onPress} testID={testID} style={({ hovered, pressed }) => ({ minHeight: 44, minWidth: 44, maxWidth: "100%", paddingHorizontal: spacing.md, paddingVertical: spacing.sm, justifyContent: "center", borderWidth: 1, borderColor: focused || active ? colors.brand : colors.controlBorder, borderRadius: 8, backgroundColor: active ? colors.brandTint : hovered || pressed ? colors.surfaceTertiary : colors.surfaceSecondary, opacity: disabled ? 0.5 : 1, ...(Platform.OS === "web" ? { cursor: disabled ? "default" : "pointer", outlineStyle: focused ? "solid" : "none", outlineColor: colors.focusRing, outlineWidth: 2, outlineOffset: 2 } : {}) } as any)}><Text style={[type.body, { color: colors.onSurface, flexShrink: 1 }]}>{label}</Text></Pressable>;
}

export function KitchenSelect({ label, value, options, onChange, testID }: { label: string; value: string; options: { value: string; label: string }[]; onChange: (value: string) => void; testID?: string }) {
  const selected = options.find(option => option.value === value)?.label || value || "Any";
  return <View style={{ gap: 8, minWidth: 0 }}><Text style={type.label}>{label}</Text><Menu triggerLabel={`${label}: ${selected}`} triggerTestID={testID} align="left" items={options.map(option => ({ label: option.label, onPress: () => onChange(option.value) }))}><View style={{ minHeight: 44, borderWidth: 1, borderColor: colors.controlBorder, borderRadius: 8, padding: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm }}><Text style={[type.body, { flex: 1 }]}>{selected}</Text><Feather name="chevron-down" size={16} color={colors.onSurfaceMuted} /></View></Menu></View>;
}

/** Calendar input on web; date-only values never acquire the browser's timezone. */
export function KitchenDateField({ label, value, onChange, disabled, testID, min, max, kind = "date", defaultToToday = true }: { defaultToToday?: boolean; label: string; value: string; onChange: (value: string) => void; disabled?: boolean; testID?: string; min?: string; max?: string; kind?: "date" | "datetime" }) {
  const id = useId();
  const initialized = useRef(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (disabled || kind !== "date" || !defaultToToday || initialized.current) return;
    initialized.current = true;
    if (!value) onChange(kitchenToday());
  }, [disabled, kind, defaultToToday, value, onChange]);
  const inputValue = kind === "datetime" ? indiaDateTime(value) : value;
  const focus = (event?: unknown) => {
    const target = (event as { currentTarget?: { value?: string } } | undefined)?.currentTarget;
    const currentValue = Platform.OS === "web" && typeof target?.value === "string" ? target.value : value;
    if (!disabled && defaultToToday && kind === "date" && !currentValue) onChange(kitchenToday());
  };
  const update = (next: string) => onChange(kind === "datetime" && next ? `${next.length === 16 ? `${next}:00` : next}+05:30` : next);
  if (Platform.OS !== "web") return kind === "datetime" ? <View style={{ gap: spacing.sm }}><TextField label={`${label} — date (India time)`} value={inputValue.split("T")[0] || ""} onChangeText={date => update(`${date}T${inputValue.split("T")[1] || "00:00"}`)} editable={!disabled} placeholder="YYYY-MM-DD" testID={testID} /><TextField label={`${label} — time (24-hour)`} value={inputValue.split("T")[1] || ""} onChangeText={time => update(`${inputValue.split("T")[0] || ""}T${time}`)} editable={!disabled} placeholder="HH:mm" testID={testID ? `${testID}-time` : undefined} /></View> : <TextField label={label} value={value} onFocus={focus} onChangeText={onChange} editable={!disabled} placeholder="YYYY-MM-DD" accessibilityHint="Date in year, month, day order. Dates use India time." testID={testID} />;
  return <View style={{ gap: 8, minWidth: 0 }}>{createElement("label", { htmlFor: id, style: { ...type.label, lineHeight: `${type.label.lineHeight}px`, color: colors.onSurface } }, label)}<View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>{createElement("input", { id, className: "kitchen-date-input", type: kind === "datetime" ? "datetime-local" : "date", value: inputValue,
    // WebKit date inputs can emit focus without focusin, which React's onFocus needs.
    ref: (input: HTMLInputElement | null) => { inputRef.current = input; if (input) input.onfocus = focus; }, onClick: focus,
    disabled, min, max, "data-testid": testID, onChange: (event: { target: { value: string } }) => update(event.target.value), style: { boxSizing: "border-box", minHeight: 44, flex: 1, width: 0, maxWidth: "100%", minWidth: 0, padding: "10px 8px", border: `1px solid ${colors.controlBorder}`, borderRadius: radius.sm, background: colors.surfaceSecondary, ...type.body, lineHeight: `${type.body.lineHeight}px`, color: colors.onSurface } })}<Pressable accessibilityRole="button" accessibilityLabel={`Open ${label.toLowerCase()} calendar`} disabled={disabled} accessibilityState={{ disabled: Boolean(disabled) }} testID={testID ? `${testID}-calendar` : undefined} onPress={() => {
      const input = inputRef.current;
      if (!input || disabled) return;
      input.focus();
      try { input.showPicker?.(); } catch { /* Browsers without script-open calendars still support direct date entry. */ }
    }} style={{ minWidth: 44, minHeight: 44, justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: colors.controlBorder, borderRadius: radius.sm, opacity: disabled ? 0.5 : 1 }}><Feather accessible={false} name="calendar" size={20} color={colors.onSurface} /></Pressable></View></View>;
}

function indiaDateTime(value: string) {
  if (!value) return "";
  if (!/[zZ]|[+-]\d\d:\d\d$/.test(value)) return value.slice(0, 16);
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return "";
  return new Date(timestamp.getTime() + 330 * 60_000).toISOString().slice(0, 16);
}
