import React from 'react';
import { View } from 'react-native';
import { Overlay } from './Overlay';
import { Button } from './controls';
import { Txt } from './typography';
import { space } from './tokens';

export function Sheet(props: React.ComponentProps<typeof Overlay>) { return <Overlay {...props} />; }

// ═════════════════════════════════════════════ Dialog ═══════════════════════
export function Dialog({
  open, onClose, title, message, confirmLabel = "Confirm", cancelLabel = "Cancel",
  tone = "ink", onConfirm, busy,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "ink" | "risk";
  onConfirm: () => void;
  busy?: boolean;
}) {
  return (
    <Sheet open={open} onClose={onClose} title={title} width={400} dismissable={!busy}>
      <View style={{ gap: space.x2, paddingTop: space.x1 }}>
        {message ? <Txt v="bodyMid">{message}</Txt> : null}
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: space.x2, marginTop: space.x5 }}>
          <Button label={cancelLabel} variant="ghost" onPress={onClose} disabled={busy} />
          <Button
            label={confirmLabel}
            variant={tone === "risk" ? "danger" : "primary"}
            onPress={onConfirm}
            loading={busy}
          />
        </View>
      </View>
    </Sheet>
  );
}
