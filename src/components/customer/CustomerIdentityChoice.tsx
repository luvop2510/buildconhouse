import { useEffect, useRef, useState } from "react";
import { View } from "react-native";
import { api } from "@/src/api/client";
import { Button, EmptyState, ErrorState, LoadingState, Sheet } from "@/src/components/ds";
import { Surface, Txt } from "@/src/design/components";
import { space } from "@/src/design/tokens";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import type { CustomerMatch } from "@/src/components/HomeCustomerSearch";

export function CustomerIdentityChoice({ name, phone, onSelect, onSeparate, onClose, autoContinueIfNoMatches, prefetched }: {
  name: string; phone: string; onSelect: (match: CustomerMatch) => void; onSeparate: () => void; onClose: () => void;
  autoContinueIfNoMatches?: boolean; prefetched?: CustomerMatch[];
}) {
  const [loadedRows, setRows] = useState<CustomerMatch[] | null>(null);
  const rows = prefetched ?? loadedRows;
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const { floors } = useFloorAccess();
  const continueWithoutMatch = useRef(onSeparate);
  continueWithoutMatch.current = onSeparate;
  const floorNames = Object.fromEntries(floors.map(floor => [floor.id, floor.name]));

  useEffect(() => {
    if (prefetched) return;
    const controller = new AbortController();
    setRows(null);
    setError(false);
    const path = `/customer-search/candidates?name=${encodeURIComponent(name)}&phone=${encodeURIComponent(phone)}`;
    void api.get<CustomerMatch[]>(path, { cacheMs: 0, signal: controller.signal }).then(rows => {
      if (controller.signal.aborted) return;
      if (autoContinueIfNoMatches && !rows.length) continueWithoutMatch.current();
      else setRows(rows);
    }).catch(() => {
      if (!controller.signal.aborted) setError(true);
    });
    return () => controller.abort();
  }, [name, phone, retry, autoContinueIfNoMatches, prefetched]);

  return <Sheet scroll visible title="Check for an existing customer" onClose={onClose}>
    <View style={{ gap: space.x3 }}>
      {error ? <ErrorState title="Customer lookup is unavailable" onRetry={() => setRetry(value => value + 1)} />
        : !rows ? <LoadingState label="Checking permitted departments…" />
        : !rows.length ? <EmptyState title="No matching customer" />
        : <>
          <Txt v="sub">Choose an existing profile if you have confirmed this is the same person.</Txt>
          {rows.map(row => <Surface key={row.id} style={{ gap: space.x2 }}>
            <Txt v="bodyMid">{row.name}</Txt>
            <Txt v="sub">{[row.phone, floorNames[row.floor_id], row.address].filter(Boolean).join(" · ")}</Txt>
            <Button label={`Use ${row.name}`} variant="secondary" onPress={() => onSelect(row)} />
          </Surface>)}
        </>}
      <Button label={rows?.length ? "Create separate customer" : "Create customer"} variant={rows?.length ? "secondary" : "primary"} disabled={!rows} onPress={onSeparate} />
    </View>
  </Sheet>;
}
