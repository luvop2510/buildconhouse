import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { Text } from "@/src/components/AppText";
import { BottomSheet } from "@/src/components/BottomSheet";
import { Alert, Button, TextField } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

const intervals = [3, 6, 7, 9, "custom"] as const;
export const DEFAULT_QUOTATION_FOLLOWUP_DAYS = 7;

export function QuotationFollowupInterval({ disabled, onChange }: {
  disabled: boolean;
  onChange: (days: number | null) => void;
}) {
  const [choice, setChoice] = useState<(typeof intervals)[number]>(DEFAULT_QUOTATION_FOLLOWUP_DAYS);
  const [customDays, setCustomDays] = useState("");
  const parsedDays = (value: string) => {
    const number = Number(value);
    return /^\d+$/.test(value) && Number.isSafeInteger(number) && number > 0 ? number : null;
  };

  return (
    <View style={{ gap: spacing.sm }}>
      <Text style={type.label}>Schedule the next follow-up in</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }}>
        {intervals.map(interval => {
          const selected = choice === interval;
          return (
            <Pressable key={interval} disabled={disabled} accessibilityRole="button"
              accessibilityState={{ selected, disabled }} testID={`quotation-followup-${interval}`}
              onPress={() => {
                setChoice(interval);
                onChange(interval === "custom" ? parsedDays(customDays) : interval);
              }}
              style={({ pressed }) => ({
                minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.md,
                borderWidth: 1, borderRadius: radius.md, borderColor: selected ? colors.brand : colors.controlBorder,
                backgroundColor: selected || pressed ? colors.brandTint : colors.surfaceSecondary,
              })}>
              <Text style={type.label}>{interval === "custom" ? "Custom" : `${interval} days`}</Text>
            </Pressable>
          );
        })}
      </View>
      {choice === "custom" ? (
        <TextField label="Number of days" placeholder="Days" value={customDays} inputMode="numeric"
          keyboardType="number-pad" editable={!disabled} testID="quotation-followup-custom-days"
          containerStyle={{ width: 156, maxWidth: "100%" }}
          error={customDays && parsedDays(customDays) == null ? "Enter a positive whole number." : null}
          onChangeText={value => { setCustomDays(value); onChange(parsedDays(value)); }} />
      ) : null}
    </View>
  );
}

export function MarkQuotationSentSheet({ visible, saving, error, onClose, onConfirm }: {
  visible: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (followupDays: number) => void;
}) {
  const [followupDays, setFollowupDays] = useState<number | null>(DEFAULT_QUOTATION_FOLLOWUP_DAYS);
  useEffect(() => { if (visible) setFollowupDays(DEFAULT_QUOTATION_FOLLOWUP_DAYS); }, [visible]);

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Send Quotation" testID="mark-quotation-sent-sheet">
      <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
        <Text style={type.body}>Confirm after you’ve sent the quotation to the customer.</Text>
        {visible ? <QuotationFollowupInterval disabled={saving} onChange={setFollowupDays} /> : null}
        {error ? <Alert tone="error" title={error} /> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", justifyContent: "flex-end", gap: spacing.sm }}>
          <Button label="Cancel" variant="secondary" onPress={onClose} disabled={saving} />
          <Button label="Confirm Send" onPress={() => { if (followupDays != null) onConfirm(followupDays); }}
            disabled={followupDays == null || saving} loading={saving} testID="confirm-mark-quotation-sent" />
        </View>
      </View>
    </BottomSheet>
  );
}
