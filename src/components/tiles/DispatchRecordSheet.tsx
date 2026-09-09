// frontend/src/components/tiles/DispatchRecordSheet.tsx
// The operational record behind one Dispatch — everything a warehouse
// operator needs to finish the job after the truck is loaded, in one place:
//
//   Open dispatch -> see its lines and Chalan
//                 -> Preview Chalan (on screen) -> PDF / Print
//                 -> Edit transport (vehicle / driver / receiver / ref)
//                 -> Mark received at Godown   (Godown-bound dispatches)
//                 -> Mark Delivered            (closes the workflow)
//
// Before this, "View Dispatch" opened a read-only 5-line summary built from
// one row of the Dispatch List, and Delivered was unreachable from any
// screen even though the backend modelled it.
import { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";

import { tileOrdersApi, type ChalanDetail, type DispatchDetail } from "@/src/api/tileOrders";
import { toast } from "@/src/components/Toast";
import { Sheet } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { tileIdentityMeta } from "@/src/components/tiles/tilePresentation";
import { downloadApiFile, printApiFile } from "@/src/utils/downloadFile";

export async function openChalanPdf(chalanId: string, mode: "view" | "print" = "view") {
  try {
    const path = `/tile-orders/chalans/${chalanId}/pdf`;
    if (mode === "print") await printApiFile(path, "Chalan PDF");
    else await downloadApiFile(path, `Chalan-${chalanId}.pdf`, "Chalan PDF");
  } catch (e: any) {
    toast.error(e?.detail || e?.message || `Could not open Chalan ${mode === "print" ? "for printing" : "PDF"}`);
  }
}

function Field({ label, value }: { label: string; value?: string | null }) {
  return (
    <View style={styles.field}>
      <Text style={type.caption}>{label}</Text>
      <Text style={type.bodyStrong}>{value || "—"}</Text>
    </View>
  );
}

const money = (value?: number | null) => `₹${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function ChalanPreviewSheet({ chalanId, onClose }: { chalanId: string; onClose: () => void }) {
  const [chalan, setChalan] = useState<ChalanDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    tileOrdersApi.chalanDetail(chalanId)
      .then((c) => { if (alive) setChalan(c); })
      .catch((e: any) => { if (alive) setError(e?.detail || "Could not load Chalan"); });
    return () => { alive = false; };
  }, [chalanId]);

  return (
    <Sheet visible onClose={onClose} title="Chalan preview" subtitle={chalan ? `${chalan.number} · ${chalan.customer_name}` : "Loading…"} testID="tile-chalan-preview-sheet">
      <ScrollView contentContainerStyle={styles.body}>
        {error ? <Text style={type.bodyStrong}>{error}</Text> : !chalan ? <ActivityIndicator color={colors.brand} /> : (
          <>
            <View style={styles.fieldGrid}>
              <Field label="Chalan no." value={chalan.number} />
              <Field label="Generated" value={`${(chalan.generated_at || "").slice(0, 16).replace("T", " ")} · ${chalan.generated_by_name}`} />
              <Field label="Brand / supplier" value={chalan.supplier_name} />
              <Field label="Customer" value={`${chalan.customer_name}${chalan.customer_phone ? ` · ${chalan.customer_phone}` : ""}`} />
              <Field label="Delivery address" value={[chalan.delivery_address, chalan.delivery_city].filter(Boolean).join(", ")} />
              <Field label="Vehicle / driver" value={[chalan.vehicle_number, chalan.driver_name].filter(Boolean).join(" · ")} />
              <Field label="Received by" value={chalan.receiver_name} />
              <Field label="Reference no." value={chalan.reference_number} />
              <Field label="Labour cost" value={money(chalan.labor_cost)} />
            </View>
            <View style={styles.table}>
              <View style={styles.tableHeader}>
                <Text style={[styles.lineCol, styles.tableLabel]}>PRODUCT</Text>
                <Text style={[styles.smallCol, styles.tableLabel]}>SIZE</Text>
                <Text style={[styles.numCol, styles.tableLabel]}>QTY</Text>
              </View>
              {chalan.items.map((line, index) => (
                <View key={`${line.po_item_id}-${index}`} style={styles.tableRow}>
                  <View style={styles.lineCol}>
                    <Text numberOfLines={1} style={type.bodyStrong}>{line.tile_name}</Text>
                    <Text numberOfLines={1} style={type.caption}>{tileIdentityMeta([line.series, line.finish])}</Text>
                  </View>
                  <Text numberOfLines={1} style={[styles.smallCol, type.bodySm]}>{line.size || "—"}</Text>
                  <Text style={[styles.numCol, styles.mono]}>{line.quantity} {line.quantity_unit === "Pieces" ? "Piece" : "Box"}</Text>
                </View>
              ))}
            </View>
            <View style={styles.actionRow}>
              <Pressable testID="tile-chalan-preview-pdf" onPress={() => openChalanPdf(chalan.id)} style={styles.primaryAction}>
                <Text style={styles.primaryActionText}>Generate PDF</Text>
              </Pressable>
              <Pressable testID="tile-chalan-preview-print" onPress={() => openChalanPdf(chalan.id, "print")} style={styles.outlineAction}>
                <Text style={styles.outlineActionText}>Print</Text>
              </Pressable>
            </View>
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

export function DispatchRecordSheet({
  dispatchId, onClose, onChanged, readOnly = false,
}: { dispatchId: string; onClose: () => void; onChanged?: () => void; readOnly?: boolean }) {
  const [detail, setDetail] = useState<DispatchDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [preview, setPreview] = useState(false);
  const [form, setForm] = useState({ vehicle_number: "", driver_name: "", receiver_name: "", reference_number: "" });
  const [receivedBy, setReceivedBy] = useState("");

  const load = useCallback(async () => {
    setError(null);
    setDetail(null);
    try {
      const next = await tileOrdersApi.dispatchDetail(dispatchId);
      setDetail(next);
      setForm({
        vehicle_number: next.chalan.vehicle_number || "", driver_name: next.chalan.driver_name || "",
        receiver_name: next.chalan.receiver_name || "", reference_number: next.chalan.reference_number || "",
      });
    } catch (e: any) {
      setError(e?.detail || "Could not load dispatch");
    }
  }, [dispatchId]);

  useEffect(() => { load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, success: string): Promise<boolean> => {
    setBusy(true);
    try {
      await fn();
      toast.success(success);
      await load();
      onChanged?.();
      return true;
    } catch (e: any) {
      toast.error(e?.detail?.message || e?.detail || "Action failed");
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveTransport = async () => {
    const saved = await run(
    () => tileOrdersApi.updateDispatchTransport(dispatchId, form),
    "Dispatch updated",
    );
    if (saved) setEditing(false);
  };

  const dispatch = detail?.dispatch;

  return (
    <>
      <Sheet
        visible onClose={onClose} title={dispatch?.dispatch_number || "Dispatch"}
        subtitle={dispatch ? `${dispatch.dispatch_date} · ${dispatch.status} · from ${dispatch.source === "godown" ? "Godown" : "Released"}` : "Loading…"}
        testID="tile-dispatch-record-sheet"
      >
        <ScrollView contentContainerStyle={styles.body}>
          {error ? <Text style={type.bodyStrong}>{error}</Text> : !detail || !dispatch ? <ActivityIndicator color={colors.brand} /> : (
            <>
              <View style={styles.fieldGrid}>
                <Field label="Customer" value={dispatch.customer_name} />
                <Field label="Brand" value={detail.brand.name} />
                <Field label="Destination" value={[dispatch.destination_name, dispatch.destination_address, dispatch.destination_city].filter(Boolean).join(", ")} />
                <Field label="Chalan no." value={detail.chalan.number} />
                <Field label="Labour cost" value={money(dispatch.labor_cost)} />
                <Field label="Raised by" value={`${dispatch.created_by_name} · ${dispatch.dispatch_time}`} />
                <Field label="Godown received" value={dispatch.godown_received_at ? `${dispatch.godown_received_at.slice(0, 16).replace("T", " ")} · ${dispatch.godown_received_by_name || ""}` : null} />
                <Field label="Delivered" value={dispatch.delivered_at ? `${dispatch.delivered_at.slice(0, 16).replace("T", " ")} · ${dispatch.delivered_by_name || ""}` : null} />
              </View>

              <Text style={[type.bodyStrong, { marginTop: spacing.sm }]}>Lines</Text>
              <View style={styles.table}>
                {detail.chalan.items.map((line, index) => (
                  <View key={`${line.po_item_id}-${index}`} style={styles.tableRow}>
                    <View style={styles.lineCol}>
                      <Text numberOfLines={1} style={type.bodyStrong}>{line.tile_name}</Text>
                      <Text numberOfLines={1} style={type.caption}>{tileIdentityMeta([line.series, line.finish, line.size])}</Text>
                    </View>
                    <Text style={[styles.numCol, styles.mono]}>{line.quantity} {line.quantity_unit === "Pieces" ? "Piece" : "Box"}</Text>
                  </View>
                ))}
              </View>

              {editing && !readOnly ? (
                <View style={{ gap: spacing.sm, marginTop: spacing.sm }}>
                  {([
                    ["vehicle_number", "Vehicle number"], ["driver_name", "Driver name"],
                    ["receiver_name", "Received by"], ["reference_number", "Reference no."],
                  ] as const).map(([key, label]) => (
                    <View key={key}>
                      <Text style={type.caption}>{label}</Text>
                      <TextInput
                        testID={`tile-dispatch-edit-${key.replace(/_/g, "-")}`}
                        value={form[key]} onChangeText={(v) => setForm((f) => ({ ...f, [key]: v }))}
                        placeholderTextColor={colors.onSurfaceSubtle} placeholder={label}
                        style={styles.input}
                      />
                    </View>
                  ))}
                  <View style={styles.actionRow}>
                    <Pressable testID="tile-dispatch-save-transport" disabled={busy} onPress={saveTransport} style={styles.primaryAction}>
                      <Text style={styles.primaryActionText}>{busy ? "Saving…" : "Save changes"}</Text>
                    </Pressable>
                    <Pressable testID="tile-dispatch-cancel-edit" onPress={() => setEditing(false)} style={styles.outlineAction}>
                      <Text style={styles.outlineActionText}>Cancel</Text>
                    </Pressable>
                  </View>
                </View>
              ) : (
                <View style={styles.actionRow}>
                  <Pressable testID="tile-dispatch-preview-chalan" onPress={() => setPreview(true)} style={styles.primaryAction}>
                    <Text style={styles.primaryActionText}>Preview Chalan</Text>
                  </Pressable>
                  <Pressable testID="tile-dispatch-open-pdf" onPress={() => openChalanPdf(detail.chalan.id)} style={styles.outlineAction}>
                    <Text style={styles.outlineActionText}>Generate PDF</Text>
                  </Pressable>
                  <Pressable testID="tile-dispatch-print" onPress={() => openChalanPdf(detail.chalan.id, "print")} style={styles.outlineAction}>
                    <Text style={styles.outlineActionText}>Print</Text>
                  </Pressable>
                  {!readOnly ? <Pressable testID="tile-dispatch-edit" onPress={() => setEditing(true)} style={styles.outlineAction}>
                    <Text style={styles.outlineActionText}>Edit dispatch</Text>
                  </Pressable> : null}
                </View>
              )}

              {dispatch.delivered_at || readOnly ? null : (
                <View style={{ gap: spacing.sm, marginTop: spacing.md, borderTopWidth: 1, borderTopColor: colors.divider, paddingTop: spacing.md }}>
                  <Text style={type.bodyStrong}>Close out</Text>
                  {dispatch.destination_type === "Godown" && !dispatch.godown_received_at ? (
                    <Pressable
                      testID="tile-dispatch-godown-received" disabled={busy}
                      onPress={() => run(() => tileOrdersApi.markGodownReceived(dispatchId), "Marked received at Godown")}
                      style={styles.outlineAction}
                    >
                      <Text style={styles.outlineActionText}>Mark received at Godown</Text>
                    </Pressable>
                  ) : null}
                  <TextInput
                    testID="tile-dispatch-received-by" value={receivedBy} onChangeText={setReceivedBy}
                    placeholder="Delivery received by (optional)" placeholderTextColor={colors.onSurfaceSubtle}
                    style={styles.input}
                  />
                  <Pressable
                    testID="tile-dispatch-mark-delivered" disabled={busy}
                    onPress={() => run(
                      () => tileOrdersApi.markDelivered(dispatchId, { received_by: receivedBy.trim() || undefined }),
                      "Marked delivered",
                    )}
                    style={[styles.primaryAction, busy ? styles.disabled : null]}
                  >
                    <Text style={styles.primaryActionText}>{busy ? "Saving…" : "Mark Delivered"}</Text>
                  </Pressable>
                </View>
              )}
            </>
          )}
        </ScrollView>
      </Sheet>
      {preview && detail ? <ChalanPreviewSheet chalanId={detail.chalan.id} onClose={() => setPreview(false)} /> : null}
    </>
  );
}

const styles = StyleSheet.create({
  body: { padding: spacing.lg, gap: spacing.sm },
  field: { minWidth: 190, flexGrow: 1, flexShrink: 1, gap: 1 },
  fieldGrid: { flexDirection: "row", flexWrap: "wrap", gap: spacing.md },
  table: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.sm, marginTop: spacing.xs },
  tableHeader: { flexDirection: "row", alignItems: "center", minHeight: 30, paddingHorizontal: spacing.sm, backgroundColor: colors.surfaceTertiary, gap: spacing.xs },
  tableRow: { flexDirection: "row", alignItems: "center", minHeight: 42, paddingHorizontal: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider, gap: spacing.xs },
  tableLabel: { ...type.overline, fontSize: 10, color: colors.onSurfaceMuted },
  lineCol: { flex: 1, minWidth: 0 }, smallCol: { width: 110 }, numCol: { width: 66, textAlign: "right" },
  mono: { ...type.bodySm, fontFamily: type.numeric.fontFamily, fontVariant: ["tabular-nums"] },
  actionRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs, marginTop: spacing.sm },
  primaryAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg, borderRadius: radius.sm, backgroundColor: colors.brand },
  primaryActionText: { ...type.bodyStrong, color: colors.onBrand },
  outlineAction: { minHeight: 44, justifyContent: "center", paddingHorizontal: spacing.lg, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.brandBorder },
  outlineActionText: { ...type.bodyStrong, color: colors.brandHover },
  disabled: { opacity: 0.6 },
  input: { borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: spacing.sm, minHeight: 44, color: colors.onSurface },
});
