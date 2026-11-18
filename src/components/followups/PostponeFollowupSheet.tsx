import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { Text } from "@/src/components/AppText";
import { Alert, Button, Sheet, TextField } from "@/src/components/ds";
import { useBp } from "@/src/design/responsive";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { FollowupDateInput } from "./FollowupDateInput";
import { addCalendarDays, followupCalendarDay, followupDateLabel, isCalendarDay } from "./followupDates";

export function PostponeFollowupSheet({ dueAt, customerName, onClose, onSave }: {
  dueAt: string;
  customerName: string;
  onClose: () => void;
  onSave: (date: string, reason: string) => Promise<void>;
}) {
  const { isPhone } = useBp();
  const [newDate, setNewDate] = useState("");
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const busy = useRef(false);

  const today = followupCalendarDay(new Date());
  const currentDay = followupCalendarDay(dueAt);
  const fromDay = currentDay > today ? currentDay : today;
  const minimum = addCalendarDays(fromDay, 1);
  const dateValid = !!currentDay && isCalendarDay(newDate) && newDate >= minimum;
  const canConfirm = dateValid && !!reason.trim();

  async function confirm() {
    if (!canConfirm || busy.current) return;
    busy.current = true;
    setSaving(true);
    setError("");
    try {
      await onSave(newDate, reason.trim());
      onClose();
    } catch (failure: any) {
      setError(typeof failure?.detail === "string" ? failure.detail : "Could not save the postponement. Try again.");
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  return (
    <Sheet visible onClose={() => { if (!busy.current) onClose(); }} variant={isPhone ? "bottom" : "modal"}
      title="Postpone follow-up" subtitle={customerName} width={480} scroll dismissable={!saving}
      footer={
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: spacing.sm }}>
          <Button label="Cancel" variant="secondary" disabled={saving} onPress={onClose} />
          <Button label="Confirm postponement" loading={saving} disabled={!canConfirm || saving}
            onPress={() => void confirm()} testID="confirm-postponement" />
        </View>
      }
    >
      <View style={{ gap: spacing.md }}>
        <View style={{ gap: spacing.xs }}>
          <Text style={type.label}>Current follow-up date</Text>
          <Text style={type.body}>{followupDateLabel(dueAt)}</Text>
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          {[1, 3, 7].map((days) => {
            const target = addCalendarDays(fromDay, days);
            const selected = newDate === target;
            const label = `+${days} ${days === 1 ? "day" : "days"}`;
            return (
              <Pressable key={days} onPress={() => setNewDate(target)} disabled={saving} accessibilityRole="button"
                accessibilityLabel={`Postpone by ${days} ${days === 1 ? "day" : "days"}`}
                accessibilityState={{ selected, disabled: saving }} testID={`postpone-days-${days}`}
                style={({ pressed }) => ({
                  minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md, borderWidth: 1,
                  borderRadius: radius.md, borderColor: selected ? colors.brand : colors.controlBorder,
                  backgroundColor: selected || pressed ? colors.brandTint : colors.surfaceSecondary,
                })}>
                <Text style={type.label}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
        {currentDay < today ? <Text style={type.caption}>Quick options count from today because this follow-up is overdue.</Text> : null}
        <FollowupDateInput label="New follow-up date" value={newDate} onChange={setNewDate} min={minimum}
          disabled={saving} required testID="postpone-date" />
        {newDate && !dateValid ? (
          <Text style={{ ...type.caption, color: colors.error }} accessibilityLiveRegion="polite">
            Choose a future date later than the current follow-up date.
          </Text>
        ) : null}
        <TextField label="Reason for postponement" helper="Required. This reason is saved in the follow-up history."
          value={reason} onChangeText={setReason} multiline maxLength={2000} editable={!saving} testID="postpone-reason" />
        {error ? <Alert tone="error" title={error} /> : null}
      </View>
    </Sheet>
  );
}
