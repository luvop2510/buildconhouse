import { useEffect, useState } from "react";
import { View } from "react-native";

import { Text } from "@/src/components/AppText";
import { BottomSheet } from "@/src/components/BottomSheet";
import { Alert, Button, TextField } from "@/src/components/ui";
import { spacing, type } from "@/src/theme/tokens";

export function MarkQuotationSentSheet({ visible, saving, error, onClose, onConfirm }: {
  visible: boolean;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: (followupDate?: string) => void;
}) {
  const [date, setDate] = useState("");
  useEffect(() => { if (visible) setDate(""); }, [visible]);

  const customDate = date.trim();
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(customDate) ? new Date(customDate + "T00:00:00Z") : null;
  const validDate = !customDate || (parsed && Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === customDate);

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Mark quotation as sent" testID="mark-quotation-sent-sheet">
      <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
        <Text style={type.body}>Confirm that you’ve already sent the quotation to the customer. The quotation will move to Pending.</Text>
        <TextField label="First follow-up date (optional)" placeholder="YYYY-MM-DD" value={date}
          onChangeText={setDate} maxLength={10} editable={!saving} testID="quotation-first-followup-date"
          helper="Leave blank to schedule the first follow-up in 7 calendar days."
          error={validDate ? null : "Enter a valid date in YYYY-MM-DD format."} />
        {error ? <Alert tone="error" title={error} /> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
          <Button label="Mark as sent" onPress={() => onConfirm(customDate || undefined)}
            disabled={!validDate || saving} loading={saving} testID="confirm-mark-quotation-sent" />
          <Button label="Cancel" variant="secondary" onPress={onClose} disabled={saving} />
        </View>
      </View>
    </BottomSheet>
  );
}
