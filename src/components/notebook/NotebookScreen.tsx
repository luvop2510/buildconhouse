import { filterValues, toggleFilterValue } from "@/src/utils/filters";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Linking, Pressable, Platform, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { useActionAccess } from "@/src/hooks/use-permissions";
import { notebookApi, type NotebookCreate } from "@/src/api/notebook";
import { BottomSheet } from "@/src/components/BottomSheet";
import { LeadScopeFields } from "@/src/components/leads/LeadScopeFields";
import { LeadScopeSheet } from "@/src/components/leads/LeadScopeSheet";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { ReferrerField } from "@/src/components/customer/ReferrerField";
import { toast } from "@/src/components/Toast";
import { Alert, ErrorState, Button, Chip, EmptyState, PageHeader, SearchField, TextField } from "@/src/components/ui";
import { FOLLOWUP_FILTERS, formatIndianDate, formatRupees, parseQuotationPrice } from "@/src/components/notebook/notebookModel";
import type { NotebookRow, NotebookStatus, NotebookView } from "@/src/components/notebook/notebookTypes";
import { useBp } from "@/src/design/responsive";
import { layout } from "@/src/design/tokens";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

const STATUS_LABELS: Record<NotebookStatus, string> = { new: "New", pending: "In progress", won: "Won", lost: "Lost" };
const EMPTY_DRAFT: NotebookCreate = { customer_name: "", customer_phone: "", address: "", referred_by: "", referrer_id: null };
type Partner = { id: string; name: string; type: "architect" | "interior_designer" } | null;

function partnerFrom(row: NotebookRow): Partner {
  return row.referrer_id && row.referrer_type ? { id: row.referrer_id, name: row.referrer_name, type: row.referrer_type } : null;
}
function statusTone(status: NotebookStatus) {
  return status === "won" ? styles.statusWon : status === "lost" ? styles.statusLost : status === "pending" ? styles.statusPending : styles.statusNew;
}

/** Shared Kitchen/Furniture lead workspace; route wrappers only supply department and phase. */
export function NotebookScreen({ floorId, floorName, view }: { floorId: string; floorName: string; view: NotebookView }) {
  const { floors } = useFloorAccess();
  const [scopeLead, setScopeLead] = useState<NotebookRow | null>(null);
  const { isPhone } = useBp(); const kitchen = floorId === "second-floor";
  const resource = view === "quotation" ? "notebook_quotations" : "notebook_walkins";
  const canCreate = useActionAccess(resource, "create");
  const canUpdate = useActionAccess(resource, "update");
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const [rows, setRows] = useState<NotebookRow[]>([]); const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all"); const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const fail = (message: string) => setFormError(message);
  const [loading, setLoading] = useState(true); const [loadingMore, setLoadingMore] = useState(false); const [saving, setSaving] = useState<string | null>(null);
  const [draftOpen, setDraftOpen] = useState(false); const [draft, setDraft] = useState<NotebookCreate>({ ...EMPTY_DRAFT, interested_floor_ids: [floorId], assignments: [], ...(kitchen ? { kitchen_type: "GI" as const } : {}) }); const [draftPartner, setDraftPartner] = useState<Partner>(null);
  const [converting, setConverting] = useState<NotebookRow | null>(null); const [quotationPrice, setQuotationPrice] = useState("");
  const [outcomeRow, setOutcomeRow] = useState<NotebookRow | null>(null); const [lostReason, setLostReason] = useState("");
  const [editing, setEditing] = useState<{ row: NotebookRow; field: "quotation_price" } | null>(null); const [editValue, setEditValue] = useState("");
  const [partnerRow, setPartnerRow] = useState<NotebookRow | null>(null); const [partner, setPartner] = useState<Partner>(null); const requestId = useRef(0);

  useEffect(() => { setFormError(null); }, [draftOpen, converting, outcomeRow, editing, partnerRow]);

  const load = useCallback(async (cursor?: string, append = false) => {
    if (!mounted.current) return;
    setLoadError(null);
    const id = ++requestId.current; if (append) setLoadingMore(true); else setLoading(true);
    try {
      const result = await notebookApi.list(floorId, { view, status: view === "followups" ? filter : undefined, q: search.trim() || undefined, cursor });
      if (id !== requestId.current) return; setRows((current) => append ? [...current, ...result.rows] : result.rows); setNextCursor(result.next_cursor);
    } catch (error: any) { if (id === requestId.current) setLoadError(error?.detail || "Could not load walk-ins."); }
    finally { if (id === requestId.current) { setLoading(false); setLoadingMore(false); } }
  }, [filter, floorId, search, view]);
  useEffect(() => { const timer = setTimeout(() => { void load(); }, search ? 250 : 0); return () => { clearTimeout(timer); requestId.current += 1; }; }, [load, search]);
  const loadRef = useRef(load);
  useEffect(() => { loadRef.current = load; }, [load]);
  const replace = (updated: NotebookRow) => setRows((current) => current.map((row) => row.id === updated.id ? updated : row));

  const create = async () => {
    if (!canCreate || saving || !mounted.current) return;
    if (!draft.customer_name.trim() || !draft.customer_phone.trim() || (kitchen && !draft.kitchen_type)) { fail("Enter the customer name, phone number, and kitchen type."); return; }
    if (!draft.interested_floor_ids?.length) { fail("Select at least one interested floor."); return; }
    if (draft.interested_floor_ids.some(floor => !draft.assignments?.some(a => a.floor_id === floor && a.user_id))) { fail("Select a team member for each interested floor."); return; }
    setSaving("draft"); try { const row = await notebookApi.create(floorId, draft); if (!mounted.current) return; setDraft({ ...EMPTY_DRAFT, interested_floor_ids: [floorId], assignments: [], ...(kitchen ? { kitchen_type: "GI" as const } : {}) }); setDraftPartner(null); setDraftOpen(false); toast.success(row.is_converted ? "Customer already in quotation follow-ups" : "Follow-up added"); void loadRef.current(); } catch (error: any) { if (mounted.current) fail(error?.detail || "Could not add the follow-up"); } finally { if (mounted.current) setSaving(null); }
  };
  const contact = (row: NotebookRow, channel: "call" | "whatsapp") => { void (async () => {
    if (!canUpdate || saving || !mounted.current) return;
    setSaving(`${row.id}:${channel}`);
    try {
      const result = await notebookApi.contact(floorId, row.id, channel);
      if (!mounted.current) return;
      const url = channel === "call" ? (result.phone ? `tel:${result.phone.replace(/\s+/g, "")}` : null) : result.wa_url;
      if (!url) toast.error(channel === "call" ? "No phone number on file" : "No WhatsApp number on file");
      else await Linking.openURL(url).catch(() => toast.error("Open the contact app manually."));
      await loadRef.current();
    } finally { if (mounted.current) setSaving(null); }
  })().catch((error: any) => { if (mounted.current) fail(error?.detail || "Could not contact customer"); }); };
  const convert = async () => {
    if (!canUpdate || saving || !mounted.current || !converting) return; const price = parseQuotationPrice(quotationPrice); if (price === null) { fail("Enter a valid quotation price"); return; }
    setSaving(`${converting.id}:convert`); try { await notebookApi.convert(floorId, converting.id, { quotation_price: price }, converting.updated_at); if (!mounted.current) return; setRows((current) => current.filter((row) => row.id !== converting.id)); setConverting(null); toast.success("Moved to quotation follow-ups"); } catch (error: any) { if (mounted.current) fail(error?.detail || "Could not move this follow-up"); } finally { if (mounted.current) setSaving(null); }
  };
  const saveOutcome = async () => {
    if (!canUpdate || saving || !mounted.current || !outcomeRow) return; if (!lostReason.trim()) { fail("A note is required before saving this outcome."); return; }
    setSaving(`${outcomeRow.id}:lost`); try { const updated = await notebookApi.outcome(floorId, outcomeRow.id, "lost", outcomeRow.updated_at, lostReason.trim(), lostReason.trim()); if (!mounted.current) return; replace(updated); setOutcomeRow(null); toast.success("Lead marked as lost"); } catch (error: any) { if (mounted.current) fail(error?.detail || "Could not save this outcome"); } finally { if (mounted.current) setSaving(null); }
  };
  const saveEdit = async () => {
    if (!canUpdate || saving || !mounted.current || !editing) return; const value = parseQuotationPrice(editValue);
    if (editing.field === "quotation_price" && value === null) { fail("Enter a valid quotation price"); return; }
    setSaving(`${editing.row.id}:${editing.field}`); try { const updated = await notebookApi.patch(floorId, editing.row.id, editing.field, value, editing.row.updated_at); if (!mounted.current) return; replace(updated); setEditing(null); toast.success("Saved"); } catch (error: any) { if (mounted.current) fail(error?.detail || "Could not save this change"); } finally { if (mounted.current) setSaving(null); }
  };
  const savePartner = async () => {
    if (!canUpdate || saving || !mounted.current || !partnerRow) return; setSaving(`${partnerRow.id}:partner`); try { const updated = await notebookApi.assignReferrer(floorId, partnerRow.id, partner?.id || null, partnerRow.updated_at); if (!mounted.current) return; replace(updated); setPartnerRow(null); toast.success(partner ? "Partner assigned" : "Partner cleared"); } catch (error: any) { if (mounted.current) fail(error?.detail || "Could not assign partner"); } finally { if (mounted.current) setSaving(null); }
  };
  const openOutcome = (row: NotebookRow) => { setOutcomeRow(row); setLostReason(""); };
  const openPartner = (row: NotebookRow) => { setPartnerRow(row); setPartner(partnerFrom(row)); };
  const openEdit = (row: NotebookRow, field: "quotation_price") => { setEditing({ row, field }); setEditValue(String(row.quotation_price ?? "")); };
  const draftFields = <View style={styles.sheetFields}>{formError ? <Alert tone="error" title={formError} /> : null}<TextField label="Customer name *" value={draft.customer_name} onChangeText={(customer_name) => setDraft((current) => ({ ...current, customer_name }))} /><TextField label="Phone *" keyboardType="phone-pad" value={draft.customer_phone} onChangeText={(customer_phone) => setDraft((current) => ({ ...current, customer_phone }))} />{kitchen ? <View style={{ gap: spacing.xs }}><Text style={type.label}>Kitchen type *</Text><View style={styles.chips}>{(["GI", "SS"] as const).map((kind) => <Chip key={kind} label={kind} active={draft.kitchen_type === kind} onPress={() => setDraft((current) => ({ ...current, kitchen_type: kind }))} />)}</View></View> : null}<TextField label="Address" value={draft.address} onChangeText={(address) => setDraft((current) => ({ ...current, address }))} /><TextField label="Referred by" value={draft.referred_by} onChangeText={(referred_by) => setDraft((current) => ({ ...current, referred_by }))} /><ReferrerField allowCreate={canCreate} floorId={floorId} label="Architect / interior designer" value={draftPartner} onChange={(value) => { setDraftPartner(value); setDraft((current) => ({ ...current, referrer_id: value?.id || null })); }} /><LeadScopeFields assignmentsRequired customerPhone={draft.customer_phone} sourceFloorId={floorId} value={{ interested_floor_ids: draft.interested_floor_ids || [floorId], assignments: draft.assignments || [], reference_source: draft.reference_source }} onChange={value => setDraft(current => ({ ...current, ...value }))} /><Button label="Add follow-up" icon="plus" onPress={() => void create()} loading={saving === "draft"} /></View>;

  return <SafeAreaView style={{ flex: 1 }} edges={isPhone ? [] : ["top"]}>
    <PageHeader title={`${floorName} ${view === "quotation" ? "Quotation follow-ups" : "Walk-ins"}`} overline="Customer register" subtitle={view === "quotation" ? "Converted opportunities awaiting a clear business outcome." : "Contact, qualify, and move every client forward."} actions={!isPhone && canCreate && view === "followups" ? <Button label="New walk-in" icon="plus" onPress={() => setDraftOpen(true)} /> : undefined} />
    <FlatList
      testID="notebook-list"
      data={loadError || loading ? [] : rows}
      keyExtractor={(row) => row.id}
      contentContainerStyle={styles.content}
      keyboardShouldPersistTaps="handled"
      initialNumToRender={6}
      maxToRenderPerBatch={6}
      windowSize={5}
      removeClippedSubviews={Platform.OS !== "web"}
      ItemSeparatorComponent={() => <View style={{ height: spacing.md }} />}
      ListHeaderComponent={<View style={styles.listHeader}>
        <SearchField value={search} onChangeText={setSearch} onClear={() => setSearch("")} placeholder="Search customer, phone, address, referral or notes" />
        {isPhone && canCreate && view === "followups" ? <Button label="New walk-in" icon="plus" onPress={() => setDraftOpen(true)} /> : null}
        {view === "followups" ? <View style={styles.chips}>{FOLLOWUP_FILTERS.map((item) => <Chip key={item} label={item === "all" ? "All" : STATUS_LABELS[item]} active={item === "all" ? filter === "all" : filterValues(filter).includes(item)} onPress={() => setFilter(current => toggleFilterValue(current, item))} />)}</View> : null}
      </View>}
      ListEmptyComponent={loadError ? <ErrorState title="Register unavailable" subtitle={loadError} onRetry={() => void load()} /> : loading ? <ActivityIndicator color={colors.brand} /> : <EmptyState icon="users" title={search ? "No matching customers" : view === "quotation" ? "No quotation follow-ups" : "No walk-ins yet"} subtitle={view === "quotation" ? "Converted opportunities remain here while the order is pending." : "Add the first customer inquiry to begin."} action={canCreate && view === "followups" ? <Button label="New walk-in" icon="plus" onPress={() => setDraftOpen(true)} /> : undefined} />}
      renderItem={({ item: row }) => <LeadCard row={row} kitchen={kitchen} quotationStage={view === "quotation"} saving={saving} canUpdate={canUpdate} onCall={() => void contact(row, "call")} onWhatsApp={() => void contact(row, "whatsapp")} onConvert={() => { setConverting(row); setQuotationPrice(""); }} onOutcome={openOutcome} onEdit={openEdit} onPartner={openPartner} onScope={setScopeLead} floorNames={floors} />}
      ListFooterComponent={nextCursor && !loadError && !loading ? <Button label="Load more" variant="secondary" onPress={() => void load(nextCursor, true)} loading={loadingMore} /> : null}
    />
    <LeadScopeSheet lead={scopeLead} floorId={floorId} onClose={() => setScopeLead(null)} onSaved={() => void load()} />
    <BottomSheet visible={draftOpen} onClose={() => setDraftOpen(false)} title="New walk-in">{draftFields}</BottomSheet>
    <BottomSheet visible={Boolean(converting)} onClose={() => setConverting(null)} title="Move to quotation follow-up"><View style={styles.sheetFields}>{formError ? <Alert tone="error" title={formError} /> : null}<Text style={type.body}>This keeps the client history together and starts an active quotation follow-up.</Text><TextField label="Quotation price *" value={quotationPrice} onChangeText={setQuotationPrice} keyboardType="decimal-pad" /><Button label="Move to quotation follow-up" icon="file-text" onPress={() => void convert()} loading={saving === `${converting?.id}:convert`} /></View></BottomSheet>
    <BottomSheet visible={Boolean(outcomeRow)} onClose={() => setOutcomeRow(null)} title="Mark lead as lost"><View style={styles.sheetFields}>{formError ? <Alert tone="error" title={formError} /> : null}<Text style={type.body}>Record why this client was lost. This reason is required and remains on the activity history.</Text><TextField label="Lost reason *" multiline value={lostReason} onChangeText={setLostReason} placeholder="Cannot afford the service, or we cannot work with this customer" /><Button label="Mark as lost" disabled={!lostReason.trim()} icon="user-x" variant="danger" onPress={() => void saveOutcome()} loading={saving === `${outcomeRow?.id}:lost`} /></View></BottomSheet>
    <BottomSheet visible={Boolean(editing)} onClose={() => setEditing(null)} title="Update quotation price"><View style={styles.sheetFields}>{formError ? <Alert tone="error" title={formError} /> : null}<TextField label="Quotation price *" keyboardType="decimal-pad" value={editValue} onChangeText={setEditValue} /><Button label="Save" icon="check" onPress={() => void saveEdit()} loading={saving === `${editing?.row.id}:${editing?.field}`} /></View></BottomSheet>
    <BottomSheet visible={Boolean(partnerRow)} onClose={() => setPartnerRow(null)} title="Assign architect or interior designer"><View style={styles.sheetFields}>{formError ? <Alert tone="error" title={formError} /> : null}<ReferrerField allowCreate={canCreate} floorId={floorId} label="Assigned partner" value={partner} onChange={setPartner} /><Button label={partner ? "Save assignment" : "Clear assignment"} icon="check" onPress={() => void savePartner()} loading={saving === `${partnerRow?.id}:partner`} /></View></BottomSheet>
  </SafeAreaView>;
}

function LeadCard({ row, kitchen, quotationStage, saving, canUpdate, onCall, onWhatsApp, onConvert, onOutcome, onEdit, onPartner, onScope, floorNames }: { row: NotebookRow; kitchen: boolean; quotationStage: boolean; saving: string | null; canUpdate: boolean; onCall: () => void; onWhatsApp: () => void; onConvert: () => void; onOutcome: (row: NotebookRow) => void; onEdit: (row: NotebookRow, field: "quotation_price") => void; onPartner: (row: NotebookRow) => void; onScope: (row: NotebookRow) => void; floorNames: { id: string; name: string }[] }) {
  const closed = row.status === "won" || row.status === "lost";
  const interests = (row.interested_floor_ids?.length ? row.interested_floor_ids : [row.floor_id || ""])
    .map(id => floorNames.find(f => f.id === id)?.name || id).filter(Boolean).join(", ");
  return <View style={[styles.card, closed && styles.closedCard]}>
    <View style={styles.cardHeader}>
      <View style={{ flex: 1, minWidth: 0, gap: 3 }}><Text style={styles.customerName}>{row.customer_name}</Text><Text selectable style={styles.phone}>{row.customer_phone}</Text></View>
      <View style={[styles.status, statusTone(row.status)]}><Text style={styles.statusText}>{STATUS_LABELS[row.status]}</Text></View>
    </View>
    <View style={styles.metadata}>
      <Pressable onPress={!closed && canUpdate ? () => onScope(row) : undefined} accessibilityRole={!closed && canUpdate ? "button" : undefined} testID={`interested-${row.id}`}>
        <Meta label="Interested" value={interests || "Select floors"} editable={!closed && canUpdate} />
      </Pressable>
      {row.assignments?.length ? <Meta label="Assigned" value={row.assignments.map(a => a.user_name || a.user_id).join(", ")} /> : null}
      {row.address ? <Meta label="Address" value={row.address} /> : null}
      {kitchen && row.kitchen_type ? <Meta label="Kitchen" value={row.kitchen_type} /> : null}
      <Pressable onPress={canUpdate ? () => onPartner(row) : undefined} accessibilityRole={canUpdate ? "button" : undefined}><Meta label="Partner" value={row.referrer_name || row.architect_interior_designer || "Assign architect / interior designer"} editable={canUpdate} /></Pressable>
      {row.reference_source || row.referred_by ? <Meta label="Reference" value={row.reference_source || row.referred_by} /> : null}
      {row.last_contacted_at ? <Meta label="Last contacted" value={formatIndianDate(row.last_contacted_at)} /> : null}
      {quotationStage ? <Pressable onPress={canUpdate ? () => onEdit(row, "quotation_price") : undefined} accessibilityRole={canUpdate ? "button" : undefined}><Meta label="Quotation value" value={formatRupees(row.quotation_price)} editable={canUpdate} /></Pressable> : null}
      {row.notes ? <Meta label={row.status === "lost" ? "Lost reason" : "Previous note"} value={row.notes} /> : null}
      {row.lost_reason ? <Meta label="Lost reason" value={row.lost_reason} /> : null}
    </View>
    {!closed && canUpdate ? <View style={styles.actions}>
      <Button label="Call" icon="phone" size="sm" variant="secondary" onPress={onCall} loading={saving === `${row.id}:call`} />
      <Button label="WhatsApp" icon="message-circle" size="sm" variant="secondary" onPress={onWhatsApp} loading={saving === `${row.id}:whatsapp`} />
      <Button label="Assign team" icon="users" size="sm" variant="secondary" onPress={() => onScope(row)} />
      {!quotationStage ? <Button label="Move to quotation" icon="file-text" size="sm" onPress={onConvert} loading={saving === `${row.id}:convert`} /> : null}
      <Button label="Lost" icon="user-x" size="sm" variant="danger" onPress={() => onOutcome(row)} loading={saving === `${row.id}:lost`} />
    </View> : null}
  </View>;
}
function Meta({ label, value, editable = false }: { label: string; value: string; editable?: boolean }) { return <View style={styles.metaRow}><Text style={styles.metaLabel}>{label}</Text><Text style={[styles.metaValue, editable && styles.editable]} numberOfLines={2}>{value}{editable ? "  Edit" : ""}</Text></View>; }
const styles = StyleSheet.create({ content: { padding: spacing.lg, paddingBottom: layout.bottomBar + spacing.xl, gap: spacing.lg }, listHeader: { gap: spacing.lg, marginBottom: spacing.lg }, card: { maxWidth: 860, width: "100%", gap: spacing.md, padding: spacing.lg, backgroundColor: colors.surfaceSecondary, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, closedCard: { opacity: 0.78 }, cardHeader: { flexDirection: "row", alignItems: "flex-start", gap: spacing.md }, customerName: { ...type.titleSm, color: colors.onSurface }, phone: { ...type.body, color: colors.onSurfaceSecondary }, status: { paddingHorizontal: spacing.sm, paddingVertical: 5, borderRadius: 999 }, statusText: { ...type.label, fontSize: 11 }, statusNew: { backgroundColor: colors.brandTint }, statusPending: { backgroundColor: colors.warningBg }, statusWon: { backgroundColor: colors.successBg }, statusLost: { backgroundColor: colors.errorBg }, metadata: { gap: spacing.xs }, metaRow: { flexDirection: "row", gap: spacing.md, alignItems: "flex-start" }, metaLabel: { ...type.caption, color: colors.onSurfaceMuted, width: 94, textTransform: "uppercase" }, metaValue: { ...type.body, color: colors.onSurface, flex: 1 }, editable: { color: colors.brand }, actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, paddingTop: spacing.sm, borderTopWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.xs }, inlineDraft: { maxWidth: 860, backgroundColor: colors.surfaceSecondary, padding: spacing.lg, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border }, sheetFields: { gap: spacing.md, paddingBottom: spacing.md } });
