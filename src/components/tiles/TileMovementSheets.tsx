// frontend/src/components/tiles/TileMovementSheets.tsx
// Bottom-sheet forms for every Tile Orders movement action, split by page
// ownership (Tile Orders workflow redesign, 2026-08):
//   - ReleaseMaterialSheet  — Brand page's ONLY action. Never touches
//     Godown/Dispatch/Chalan; it's purely "the brand gave BuildCon N boxes".
//   - MoveToGodownSheet     — Customer page. Released -> Godown. No Chalan.
//   - DispatchFromReleasedSheet / DispatchFromGodownSheet — Customer page.
//     Always create a Dispatch + Chalan and auto-open the PDF.
// Replaces src/components/tiles/ReadyDispatchSheets.tsx (MarkReadySheet /
// DispatchSheet), which conflated all of this into one Brand-owned action.
import { useState } from "react";
import { ActivityIndicator, Pressable, Text, TextInput, View } from "react-native";

import { tileOrdersApi, type CustomerOrderItem, type DispatchDestinationOverride, type PurchaseOrderItemDetail } from "@/src/api/tileOrders";
import { toast } from "@/src/components/Toast";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { Sheet } from "@/src/design/components";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { tileIdentityMeta } from "@/src/components/tiles/tilePresentation";

function SheetFooter({ onCancel, onConfirm, confirmLabel, busy, disabled = false }: { onCancel: () => void; onConfirm: () => void; confirmLabel: string; busy: boolean; disabled?: boolean }) {
  return (
    <View style={{ flexDirection: "row", gap: spacing.sm }}>
      <Pressable accessibilityRole="button" accessibilityLabel="Cancel" disabled={busy} onPress={onCancel} style={{ flex: 1, padding: spacing.md, alignItems: "center", borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, opacity: busy ? 0.5 : 1 }}>
        <Text style={type.bodyStrong}>Cancel</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={confirmLabel} disabled={busy || disabled} onPress={onConfirm} style={{ flex: 1, flexDirection: "row", justifyContent: "center", alignItems: "center", gap: spacing.xs, padding: spacing.md, borderRadius: radius.md, backgroundColor: colors.brand, opacity: busy || disabled ? 0.55 : 1 }}>
        {busy ? <ActivityIndicator size="small" color={colors.onBrand} /> : null}
        <Text style={[type.bodyStrong, { color: colors.onBrand }]}>{busy ? "Processing…" : confirmLabel}</Text>
      </Pressable>
    </View>
  );
}

function QtyRow({ name, hint, value, onChange, error }: { name: string; hint: string; value: string; onChange: (v: string) => void; error?: string }) {
  return (
    <View style={{ marginBottom: spacing.md }}>
      <Text style={type.bodyStrong}>{name}</Text>
      <Text style={type.bodyMuted}>{hint}</Text>
      <TextInput
        accessibilityLabel={`Enter quantity for ${name}`}
        keyboardType="numeric" placeholder="Boxes"
        value={value} onChangeText={onChange}
        style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, minHeight: 44, marginTop: spacing.xs }}
      />
      {error ? <Text style={{ ...type.caption, color: colors.errorFg, marginTop: spacing.xs }}>{error}</Text> : null}
    </View>
  );
}

// Each sheet opens with the full available quantity already filled in —
// the common case is "move/dispatch everything that is available", and an
// empty field made every Confirm button reject the first tap with "Enter
// at least one quantity".
function prefill<T>(items: T[], id: (item: T) => string, max: (item: T) => number) {
  return Object.fromEntries(items.filter((item) => max(item) > 0).map((item) => [id(item), String(max(item))]));
}

type QuantityRow = { id: string; name: string; available: number };

function validateQuantities(qtyByItem: Record<string, string>, rows: QuantityRow[]) {
  const entries: { po_item_id: string; qty: number }[] = [];
  const errors: Record<string, string> = {};

  for (const row of rows) {
    const raw = (qtyByItem[row.id] || "").trim();
    // Clearing a prefilled line deliberately excludes it from this movement.
    if (!raw) continue;
    if (!/^\d+$/.test(raw)) {
      errors[row.id] = "Enter a whole number.";
      continue;
    }
    const qty = Number(raw);
    if (!Number.isSafeInteger(qty) || qty <= 0) {
      errors[row.id] = "Enter a positive whole number.";
    } else if (qty > row.available) {
      errors[row.id] = `Only ${row.available} available.`;
    } else {
      entries.push({ po_item_id: row.id, qty });
    }
  }

  return { entries, errors, formError: entries.length === 0 && Object.keys(errors).length === 0 ? "Enter at least one quantity." : null };
}

function qtyUnit(unit: "Box" | "Pieces" | undefined) {
  return unit === "Pieces" ? "pieces" : "boxes";
}

// ---------------------------------------------------------------- Brand page
export function ReleaseMaterialSheet({ poId, items, onClose, onDone }: { poId: string; items: PurchaseOrderItemDetail[]; onClose: () => void; onDone: () => void }) {
  const [qtyByItem, setQtyByItem] = useState<Record<string, string>>(
    () => prefill(items, (item) => item.id, (item) => item.boxes_pending),
  );
  const [busy, setBusy] = useState(false);
  const validation = validateQuantities(qtyByItem, items
    .filter((item) => item.boxes_pending > 0)
    .map((item) => ({ id: item.id, name: item.name, available: item.boxes_pending })));

  const submit = async () => {
    if (Object.keys(validation.errors).length || validation.formError) {
      toast.error("Fix the highlighted quantities before confirming");
      return;
    }
    setBusy(true);
    try {
      await tileOrdersApi.releaseMaterial(poId, validation.entries);
      toast.success("Material released");
      onDone();
    } catch (e: any) {
      toast.error(e?.detail || "Could not release material");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title="Release Material" footer={<SheetFooter onCancel={onClose} onConfirm={submit} confirmLabel="Confirm Release" busy={busy} disabled={Boolean(Object.keys(validation.errors).length || validation.formError)} />}>
      <View style={{ marginVertical: spacing.md }}>
        {items.filter((item) => item.boxes_pending > 0).map((item) => (
          <QtyRow
            key={item.id} name={item.name} hint={`${item.sku ? `${tileIdentityMeta([], item.sku)} · ` : ""}${item.boxes_pending} ${qtyUnit(item.quantity_unit)} remaining`}
            value={qtyByItem[item.id] || ""} onChange={(v) => setQtyByItem((s) => ({ ...s, [item.id]: v }))} error={validation.errors[item.id]}
          />
        ))}
        {validation.formError ? <Text style={{ ...type.caption, color: colors.errorFg }}>{validation.formError}</Text> : null}
      </View>
    </Sheet>
  );
}

// ------------------------------------------------------------- Customer page
export function MoveToGodownSheet({ poId, items, onClose, onDone }: { poId: string; items: CustomerOrderItem[]; onClose: () => void; onDone: () => void }) {
  const [qtyByItem, setQtyByItem] = useState<Record<string, string>>(
    () => prefill(items, (item) => item.po_item_id, (item) => item.boxes_ready),
  );
  const [busy, setBusy] = useState(false);
  const validation = validateQuantities(qtyByItem, items
    .filter((item) => item.boxes_ready > 0)
    .map((item) => ({ id: item.po_item_id, name: item.tile_name, available: item.boxes_ready })));

  const submit = async () => {
    if (Object.keys(validation.errors).length || validation.formError) {
      toast.error("Fix the highlighted quantities before confirming");
      return;
    }
    setBusy(true);
    try {
      await tileOrdersApi.moveToGodown(poId, validation.entries);
      toast.success("Moved to Godown");
      onDone();
    } catch (e: any) {
      toast.error(e?.detail || "Could not move to Godown");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onClose={onClose} title="Move to Godown" footer={<SheetFooter onCancel={onClose} onConfirm={submit} confirmLabel="Confirm Move" busy={busy} disabled={Boolean(Object.keys(validation.errors).length || validation.formError)} />}>
      <View style={{ marginVertical: spacing.md }}>
        {items.filter((item) => item.boxes_ready > 0).map((item) => (
          <QtyRow
            key={item.po_item_id} name={item.tile_name} hint={`${item.sku ? `${tileIdentityMeta([], item.sku)} · ` : ""}${item.boxes_ready} ${qtyUnit(item.quantity_unit)} Released`}
            value={qtyByItem[item.po_item_id] || ""} onChange={(v) => setQtyByItem((s) => ({ ...s, [item.po_item_id]: v }))} error={validation.errors[item.po_item_id]}
          />
        ))}
        {validation.formError ? <Text style={{ ...type.caption, color: colors.errorFg }}>{validation.formError}</Text> : null}
      </View>
    </Sheet>
  );
}

// Transport details a warehouse fills in at dispatch time. TileChalan has
// always had vehicle_number/driver_name columns (they print on the Chalan
// PDF and show on the Dispatch List) but nothing ever collected them, so
// both rendered permanently blank.
export type TransportDetails = { vehicle_number: string; driver_name: string; receiver_name: string; reference_number: string; labor_cost: string };
const EMPTY_TRANSPORT: TransportDetails = { vehicle_number: "", driver_name: "", receiver_name: "", reference_number: "", labor_cost: "" };

function TransportFields({ value, onChange }: { value: TransportDetails; onChange: (next: TransportDetails) => void }) {
  const field = (key: keyof TransportDetails, label: string, placeholder: string) => (
    <View style={{ flex: 1, minWidth: 150 }}>
      <Text style={type.caption}>{label}</Text>
      <TextInput
        accessibilityLabel={label}
        testID={`tile-dispatch-${key.replace(/_/g, "-")}`}
        keyboardType={key === "labor_cost" ? "decimal-pad" : "default"}
        value={value[key]} onChangeText={(v) => onChange({ ...value, [key]: v })} placeholder={placeholder}
        placeholderTextColor={colors.onSurfaceSubtle}
        style={{ borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, minHeight: 44, marginTop: 2 }}
      />
    </View>
  );
  return (
    <View style={{ gap: spacing.sm, marginBottom: spacing.md }}>
      <Text style={type.bodyStrong}>Transport details</Text>
      <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
        {field("vehicle_number", "Vehicle number", "GJ-01-AB-1234")}
        {field("driver_name", "Driver name", "Driver")}
      </View>
      <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
        {field("receiver_name", "Received by", "Site contact")}
        {field("reference_number", "Reference no.", "Optional")}
      </View>
      <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
        {field("labor_cost", "Labour cost", "Added to payment")}
      </View>
    </View>
  );
}

function transportPayload(t: TransportDetails): DispatchDestinationOverride {
  const laborCost = Number(t.labor_cost || 0);
  if (!Number.isFinite(laborCost) || laborCost < 0) throw new Error("Enter a valid labour cost");
  return {
    ...Object.fromEntries(Object.entries(t).filter(([key, value]) => key !== "labor_cost" && value.trim() !== "")),
    ...(laborCost > 0 ? { labor_cost: laborCost } : {}),
  };
}

async function submitDispatch(
  poId: string, entries: { po_item_id: string; qty: number }[],
  fn: (poId: string, entries: { po_item_id: string; qty: number }[]) => Promise<{ chalan: { id: string; [key: string]: any } }>,
  onDone: () => void, setBusy: (b: boolean) => void,
) {
  setBusy(true);
  let result: { chalan: { id: string; [key: string]: any } };
  try {
    result = await fn(poId, entries);
  } catch (e: any) {
    toast.error(e?.detail || "Could not dispatch");
    setBusy(false);
    return;
  }
  // Dispatch + Chalan are already committed server-side at this point —
  // anything below (minting a download token, opening the PDF) is a
  // best-effort convenience. A failure here must never surface as "Could
  // not dispatch" (that already succeeded); it only affects whether the
  // PDF opens automatically.
  toast.success("Dispatched — Chalan generated");
  onDone();
  setBusy(false);
  try {
    await downloadApiFile(`/tile-orders/chalans/${result.chalan.id}/pdf`, `Chalan-${result.chalan.id}.pdf`, "Chalan PDF");
  } catch {
    toast.error("Dispatch saved. Open the Chalan PDF from the Dispatch List tab.");
  }
}

function DispatchSheet({
  title, poId, items, available, dispatch, onClose, onDone,
}: {
  title: string; poId: string; items: CustomerOrderItem[];
  available: (item: CustomerOrderItem) => number;
  dispatch: (poId: string, entries: { po_item_id: string; qty: number }[], destination: DispatchDestinationOverride) => Promise<{ chalan: { id: string; [key: string]: any } }>;
  onClose: () => void; onDone: () => void;
}) {
  const [qtyByItem, setQtyByItem] = useState<Record<string, string>>(
    () => prefill(items, (item) => item.po_item_id, available),
  );
  const [transport, setTransport] = useState<TransportDetails>(EMPTY_TRANSPORT);
  const [busy, setBusy] = useState(false);
  const validation = validateQuantities(qtyByItem, items
    .filter((item) => available(item) > 0)
    .map((item) => ({ id: item.po_item_id, name: item.tile_name, available: available(item) })));

  const submit = async () => {
    if (Object.keys(validation.errors).length || validation.formError) {
      toast.error("Fix the highlighted quantities before confirming");
      return;
    }
    try {
      await submitDispatch(poId, validation.entries, (id, e) => dispatch(id, e, transportPayload(transport)), onDone, setBusy);
    } catch (e: any) {
      toast.error(e?.message || "Could not dispatch");
    }
  };

  return (
    <Sheet open onClose={onClose} title={title} footer={<SheetFooter onCancel={onClose} onConfirm={submit} confirmLabel="Confirm Dispatch" busy={busy} disabled={Boolean(Object.keys(validation.errors).length || validation.formError)} />}>
      <View style={{ marginVertical: spacing.md }}>
        {items.filter((item) => available(item) > 0).map((item) => (
          <QtyRow
            key={item.po_item_id} name={item.tile_name} hint={`${item.sku ? `${tileIdentityMeta([], item.sku)} · ` : ""}${available(item)} ${qtyUnit(item.quantity_unit)} available`}
            value={qtyByItem[item.po_item_id] || ""} onChange={(v) => setQtyByItem((s) => ({ ...s, [item.po_item_id]: v }))} error={validation.errors[item.po_item_id]}
          />
        ))}
        {validation.formError ? <Text style={{ ...type.caption, color: colors.errorFg, marginBottom: spacing.sm }}>{validation.formError}</Text> : null}
        <TransportFields value={transport} onChange={setTransport} />
      </View>
      <Text style={[type.bodyMuted, { marginBottom: spacing.sm }]}>Creates a Dispatch, generates a Chalan, and opens the PDF.</Text>
    </Sheet>
  );
}

export function DispatchFromReleasedSheet({ poId, items, onClose, onDone }: { poId: string; items: CustomerOrderItem[]; onClose: () => void; onDone: () => void }) {
  return (
    <DispatchSheet
      title="Dispatch from Released" poId={poId} items={items} available={(item) => item.boxes_ready}
      dispatch={(id, entries, destination) => tileOrdersApi.dispatchFromReleased(id, entries, destination)}
      onClose={onClose} onDone={onDone}
    />
  );
}

export function DispatchFromGodownSheet({ poId, items, onClose, onDone }: { poId: string; items: CustomerOrderItem[]; onClose: () => void; onDone: () => void }) {
  return (
    <DispatchSheet
      title="Dispatch from Godown" poId={poId} items={items} available={(item) => item.boxes_godown}
      dispatch={(id, entries, destination) => tileOrdersApi.dispatchFromGodown(id, entries, destination)}
      onClose={onClose} onDone={onDone}
    />
  );
}
