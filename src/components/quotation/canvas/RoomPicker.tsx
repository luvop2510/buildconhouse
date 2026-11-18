import { useState } from "react";

import { BottomSheet } from "@/src/components/BottomSheet";
import { Button, IconButton } from "@/src/components/ui";
import { useBuilder } from "../context/BuilderContext";

export function RoomPicker() {
  const b = useBuilder();
  const [open, setOpen] = useState(false);
  if (b.s.rooms.length < 4) return null;
  const close = () => setOpen(false);

  return <>
    <IconButton icon="chevrons-down" tone="ghost" accessibilityLabel="Choose room" onPress={() => setOpen(true)} testID="choose-quotation-room" />
    <BottomSheet visible={open} onClose={close} title="Choose room" testID="select-quotation-room-sheet">
      {b.s.rooms.map(room => <Button key={room} label={room} fullWidth variant={room === b.s.activeRoom ? "brandLight" : "ghost"}
        icon={room === b.s.activeRoom ? "check" : undefined}
        onPress={() => { b.setActiveRoom(room); close(); }} testID={`choose-room-${room}`} />)}
    </BottomSheet>
  </>;
}
