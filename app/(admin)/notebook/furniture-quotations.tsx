import { formatPhone } from "@/src/utils/phone";
import { useEffect, useRef, useState } from "react";
import { Platform, ScrollView, StyleSheet, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Text } from "@/src/components/AppText";
import { CustomerLinkField } from "@/src/components/customer/CustomerLinkField";
import { ReferrerField } from "@/src/components/customer/ReferrerField";
import { referrerLabel } from "@/src/utils/referrer";
import { Alert, Button, Chip, EmptyState, PageHeader, TextField } from "@/src/components/ui";
import { handleTableScrollKey } from "@/src/components/tableLayout";
import { toast } from "@/src/components/Toast";
import { furnitureQuotationsApi, type FurnitureDraft, type FurnitureQuotation, type FurnitureSummary, type WhatsAppReceipt } from "@/src/api/furnitureQuotations";
import { FURNITURE_FLOOR_ID } from "@/src/constants/floors";
import { useRequireFloorAccess } from "@/src/hooks/use-floor-access";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { useAuth } from "@/src/state/auth";
import { downloadApiFile, shareApiPdf } from "@/src/utils/downloadFile";
import { mergeFurnitureAcquisition } from "@/src/utils/furnitureEnrichment";
import { chargeCents, depositCents, furnitureCurrencyLabel, ledgerTotals, rmbText } from "@/src/utils/furnitureRmb";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

const newDraft = (): FurnitureDraft => ({ customer_name: "", customer_phone: "", referrer_id: null, referrer_name: null, referrer_type: null, referrer_company: null, status: "draft", charges: [
  { description: "TOTAL PURCHASE", amount_rmb: "" }, { description: "CHARGE", amount_rmb: "" },
], deposits: [] });
const date = (value?: string) => value ? new Date(value).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }) : "On save";
const formFrom = (doc: FurnitureQuotation): FurnitureDraft => ({ customer_id: doc.customer_id, customer_name: doc.customer_name, customer_phone: doc.customer_phone,
  status: doc.status, charges: doc.charges, deposits: doc.deposits,
  referrer_id: doc.referrer_id ?? null, referrer_name: doc.referrer_name ?? null,
  referrer_type: doc.referrer_type ?? null, referrer_company: doc.referrer_company ?? null });
const defaultMessage = (doc: FurnitureQuotation) => `Dear ${doc.customer_name}, please find your furniture quotation attached. Balance: RNB ${doc.balance_rmb}.`;
const LEDGER_COLUMN_WIDTH = 145;
const LEDGER_WIDTH = 7 * LEDGER_COLUMN_WIDTH;

export default function FurnitureQuotations() {
  const authorized = useRequireFloorAccess(FURNITURE_FLOOR_ID);
  const { staff } = useAuth();
  const legacyCanEdit = Boolean(staff && ["owner", "admin", "manager", "sales"].includes(staff.role));
  const canCreate = useActionAccess("furniture_quotations", "create", legacyCanEdit);
  const canUpdate = useActionAccess("furniture_quotations", "update", legacyCanEdit);
  const canExport = useActionAccess("furniture_quotations", "export");
  const canSend = useActionAccess("furniture_quotations", "export", legacyCanEdit);
  const [rows, setRows] = useState<FurnitureSummary[]>([]), [cursor, setCursor] = useState<string | null>(null);
  const [draft, setDraft] = useState<FurnitureDraft | null>(null), [saved, setSaved] = useState<FurnitureQuotation | null>(null);
  const [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [whatsAppConfigured, setWhatsAppConfigured] = useState<boolean | null>(null), [receipt, setReceipt] = useState<WhatsAppReceipt | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [configurationAttempt, setConfigurationAttempt] = useState(0);
  const requestVersion = useRef(0), sendKey = useRef("");
  const load = async (more = false) => {
    const version = ++requestVersion.current;
    setBusy("list"); setError(null);
    try { const result = await furnitureQuotationsApi.list(more ? cursor || undefined : undefined);
      if (version !== requestVersion.current) return;
      setRows((current) => more ? [...current, ...result.rows] : result.rows); setCursor(result.next_cursor);
    } catch (err: any) { if (version === requestVersion.current) setError(typeof err?.detail === "string" ? err.detail : "Could not load furniture quotations."); }
    finally { if (version === requestVersion.current) setBusy(null); }
  };
  // Provider checks load independently: a slow or unavailable WhatsApp service
  // must not delay the quotation list or repeat for every pagination request.
  useEffect(() => {
    if (!authorized || !canSend) return;
    let alive = true;
    setWhatsAppConfigured(null); setConfigurationError(null);
    void furnitureQuotationsApi.configuration()
      .then((configuration) => { if (alive) setWhatsAppConfigured(configuration.configured); })
      .catch(() => { if (alive) {
        setWhatsAppConfigured(false);
        setConfigurationError("Could not check WhatsApp availability. Your quotation and PDF remain available.");
      } });
    return () => { alive = false; };
  }, [authorized, canSend, configurationAttempt]);
  useEffect(() => { if (authorized) void load(); return () => { requestVersion.current += 1; }; }, [authorized]); // eslint-disable-line react-hooks/exhaustive-deps
  const open = async (id: string) => {
    const version = ++requestVersion.current; setBusy("open"); setError(null);
    try { const doc = await furnitureQuotationsApi.get(id, false); if (version !== requestVersion.current) return;
      setSaved(doc); setDraft(formFrom(doc)); setMessage(defaultMessage(doc)); sendKey.current = ""; setReceipt(null);
      // Acquisition counts are useful context, but must not block the ledger.
      if (doc.referrer_id) void furnitureQuotationsApi.get(id).then((enriched) => {
        if (version !== requestVersion.current) return;
        setSaved((current) => mergeFurnitureAcquisition(current, enriched, version === requestVersion.current));
      }).catch(() => {});
    } catch (err: any) { if (version === requestVersion.current) setError(typeof err?.detail === "string" ? err.detail : "Could not open the quotation."); }
    finally { if (version === requestVersion.current) setBusy(null); }
  };
  const save = async (finalize = false) => {
    if (!authorized || !draft || busy || !(saved ? canUpdate : canCreate)) return;
    const totals = ledgerTotals(draft.charges, draft.deposits);
    if (!draft.customer_name.trim() || !draft.customer_phone.trim() || totals.payable === null || totals.received === null
      || draft.charges.some((row) => !row.description.trim()) || draft.deposits.some((row) => !row.description.trim())) {
      setError("Enter the customer details, descriptions, and positive amounts/rates (up to six decimal places). Remove unused charge rows."); return;
    }
    const version = ++requestVersion.current; setBusy("save"); setError(null);
    try { const body = { ...draft, status: finalize ? "final" as const : draft.status };
      const doc = saved ? await furnitureQuotationsApi.save(saved.id, body, saved.updated_at) : await furnitureQuotationsApi.create(body);
      if (version !== requestVersion.current) return;
      setSaved(doc); setDraft(formFrom(doc)); sendKey.current = ""; setReceipt(null);
      if (!message.trim() || (saved && message === defaultMessage(saved))) setMessage(defaultMessage(doc));
      toast.success(finalize ? "Quotation finalized" : "Quotation saved");
    } catch (err: any) { if (version === requestVersion.current) setError(typeof err?.detail === "string" ? err.detail : "Could not save. Check every amount and rate, then retry."); }
    finally { if (version === requestVersion.current) setBusy(null); }
  };
  const send = async () => {
    if (!authorized || !canSend || whatsAppConfigured !== true || busy) return;
    if (!saved || !message.trim()) { setError("Enter the accompanying WhatsApp message."); return; }
    const version = ++requestVersion.current; setBusy("send"); setError(null);
    sendKey.current ||= `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    try { const result = await furnitureQuotationsApi.send(saved, message.trim(), sendKey.current);
      if (version !== requestVersion.current) return;
      setReceipt(result);
      if (["accepted", "sent", "delivered", "read"].includes(result.status)) toast.success(result.status === "accepted" ? "WhatsApp submission accepted" : `WhatsApp: ${result.status}`);
      else setError(result.status === "failed" ? "WhatsApp could not send the PDF. Review the delivery status before making a new attempt." : "WhatsApp delivery is unconfirmed. Refresh the status before making a new attempt.");
    } catch (err: any) { if (version === requestVersion.current) {
      setReceipt({ status: "unknown" });
      setError(typeof err?.detail === "string" ? err.detail : "WhatsApp delivery is unconfirmed. Refresh its status before making another attempt.");
    } }
    finally { if (version === requestVersion.current) setBusy(null); }
  };
  const refreshReceipt = async () => {
    if (!saved || !sendKey.current) return;
    const version = ++requestVersion.current; setBusy("receipt");
    try { const result = await furnitureQuotationsApi.receipt(saved.id, sendKey.current); if (version === requestVersion.current) setReceipt(result); }
    catch (err: any) { if (version === requestVersion.current) setError(typeof err?.detail === "string" ? err.detail : "Could not refresh WhatsApp status."); }
    finally { if (version === requestVersion.current) setBusy(null); }
  };
  const dirty = Boolean(draft && (!saved || JSON.stringify(draft) !== JSON.stringify(formFrom(saved))));
  const locked = saved?.status === "final";
  const editable = Boolean(saved ? canUpdate : canCreate);
  const totals = draft ? ledgerTotals(draft.charges, draft.deposits) : null;
  if (!authorized) return <EmptyState title="Loading Furniture Floor access" />;
  return <SafeAreaView style={styles.screen} edges={["top"]}>
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" testID="furniture-quotations">
      <PageHeader title="Furniture quotations" subtitle="RNB quotation and customer deposits" embedded />
      {error ? <Alert tone="error" title={error} /> : null}
      {!draft ? <>
        {canCreate ? <Button label="New RNB quotation" icon="plus" disabled={Boolean(busy)} onPress={() => { requestVersion.current += 1; setSaved(null); setDraft(newDraft()); setError(null); setMessage(""); }} /> : null}
        {rows.length === 0 ? <EmptyState title={busy ? "Loading quotations" : "No furniture quotations yet"} subtitle="Create a quotation using your RNB layout." /> : rows.map((row) => <View key={row.id} style={styles.card}>
          <Text style={type.titleMd}>{row.customer_name}</Text><Text style={type.bodyMuted}>{row.status === "final" ? "Finalized" : "Draft"} · {date(row.updated_at)}</Text>
          <Text style={type.body}>Payable RNB {row.total_payable_rmb} · Received RNB {row.total_received_rmb}</Text><Text style={type.titleSm}>Balance RNB {row.balance_rmb}</Text>
          <Button label={`Open ${row.customer_name}`} variant="secondary" disabled={Boolean(busy)} onPress={() => void open(row.id)} />
        </View>)}
        {cursor ? <Button label="Load more quotations" loading={busy === "list"} onPress={() => void load(true)} /> : null}
        {error ? <Button label="Reload quotations" variant="secondary" onPress={() => void load()} /> : null}
      </> : <>
        <View style={styles.actions}><Button label="Quotation list" variant="secondary" disabled={Boolean(busy)} onPress={() => { setDraft(null); setSaved(null); setError(null); void load(); }} />
          {saved ? <Button label="Reload saved quotation" variant="ghost" disabled={Boolean(busy)} onPress={() => void open(saved.id)} /> : null}</View>
        <View style={styles.card}>
          {editable && !locked && !busy ? <CustomerLinkField value={draft.customer_id} floorId={FURNITURE_FLOOR_ID}
            onChange={customer => setDraft({ ...draft, customer_id: customer?.id ?? null,
              ...(customer ? { customer_name: customer.name, customer_phone: customer.phone || "" } : {}) })} /> : null}
          <TextField label="Customer name / quotation heading (RDCL)" value={draft.customer_name} editable={editable && !locked && !busy} onChangeText={(customer_name) => setDraft({ ...draft, customer_name })} />
          <TextField label="Customer WhatsApp mobile" keyboardType="phone-pad" value={draft.customer_phone} editable={editable && !locked && !busy} onChangeText={(customer_phone) => setDraft({ ...draft, customer_phone })} />
          {editable && !locked && !busy ? <ReferrerField floorId={FURNITURE_FLOOR_ID}
            value={draft.referrer_id && draft.referrer_type ? { id: draft.referrer_id, name: draft.referrer_name || "", type: draft.referrer_type, company: draft.referrer_company } : null}
            onChange={(partner) => setDraft({ ...draft, referrer_id: partner?.id ?? null,
              referrer_name: partner?.name ?? null, referrer_type: partner?.type ?? null, referrer_company: partner?.company ?? null })}
          /> : draft.referrer_id ? <Text style={type.body}>Referred by {referrerLabel(draft)}{draft.referrer_company ? ` · ${draft.referrer_company}` : ""}</Text> : null}
          {saved?.referrer_id && saved.referrer_id === draft.referrer_id && saved.referrer_customers_acquired != null ? <Text style={type.bodyMuted}>{saved.referrer_customers_acquired} customers brought</Text> : null}
          <Text style={type.bodyMuted}>{saved ? `Revision ${saved.revision} · Updated ${date(saved.updated_at)}` : "Every saved change receives a date."}</Text>
          {locked ? <Text style={type.bodyMuted}>Finalized charges are locked. Customer deposits can still be recorded.</Text> : null}
        </View>
        <Text style={type.titleMd}>RNB payable</Text>
        {draft.charges.map((row, index) => <View key={row.id || `charge-${index}`} style={styles.card}>
          <TextField label={`Charge ${index + 1} description`} value={row.description} editable={editable && !locked && !busy} onChangeText={(description) => setDraft({ ...draft, charges: draft.charges.map((entry, i) => i === index ? { ...entry, description } : entry) })} />
          <TextField label={`Charge ${index + 1} RNB`} value={row.amount_rmb} keyboardType="decimal-pad" editable={editable && !locked && !busy} onChangeText={(amount_rmb) => setDraft({ ...draft, charges: draft.charges.map((entry, i) => i === index ? { ...entry, amount_rmb } : entry) })} />
          <Text style={type.bodyMuted}>Updated {date(row.updated_at)}</Text>
          {editable && !locked && draft.charges.length > 1 ? <Button label={`Remove charge ${index + 1}`} variant="ghost" disabled={Boolean(busy)} onPress={() => setDraft({ ...draft, charges: draft.charges.filter((_, i) => i !== index) })} /> : null}
        </View>)}
        {editable && !locked ? <Button label="Add charge / expense" variant="secondary" disabled={Boolean(busy) || draft.charges.length >= 200} onPress={() => setDraft({ ...draft, charges: [...draft.charges, { description: "EXPENSE", amount_rmb: "" }] })} /> : null}
        <Text style={type.titleMd}>Customer deposits</Text>
        {draft.deposits.map((row, index) => <View key={row.id || `deposit-${index}`} style={styles.card}>
          <TextField label={`Deposit ${index + 1} description`} value={row.description} editable={editable && !busy} onChangeText={(description) => setDraft({ ...draft, deposits: draft.deposits.map((entry, i) => i === index ? { ...entry, description } : entry) })} />
          <View style={styles.actions}>{(["INR", "USD", "RMB"] as const).map((currency) => <Chip key={currency} label={furnitureCurrencyLabel(currency)} active={row.currency === currency} onPress={!editable || busy ? undefined : () => setDraft({ ...draft, deposits: draft.deposits.map((entry, i) => i === index ? { ...entry, currency, rate: currency === "RMB" ? "1" : "" } : entry) })} />)}</View>
          <TextField label={`Deposit ${index + 1} amount (${furnitureCurrencyLabel(row.currency)})`} keyboardType="decimal-pad" value={row.amount} editable={editable && !busy} onChangeText={(amount) => setDraft({ ...draft, deposits: draft.deposits.map((entry, i) => i === index ? { ...entry, amount } : entry) })} />
          <TextField label={row.currency === "INR" ? "Rate: INR per RNB (divide)" : row.currency === "USD" ? "Rate: RNB per USD (multiply)" : "RNB rate"} keyboardType="decimal-pad" value={row.rate} editable={editable && !busy && row.currency !== "RMB"} onChangeText={(rate) => setDraft({ ...draft, deposits: draft.deposits.map((entry, i) => i === index ? { ...entry, rate } : entry) })} />
          <Text style={type.body}>Received RNB {rmbText(depositCents(row))}</Text><Text style={type.bodyMuted}>Updated {date(row.updated_at)}</Text>
          {editable ? <Button label={`Remove deposit ${index + 1}`} variant="ghost" disabled={Boolean(busy)} onPress={() => setDraft({ ...draft, deposits: draft.deposits.filter((_, i) => i !== index) })} /> : null}
        </View>)}
        {editable ? <Button label="Add customer deposit" variant="secondary" disabled={Boolean(busy) || draft.deposits.length >= 200} onPress={() => setDraft({ ...draft, deposits: [...draft.deposits, { description: "Deposit by customer", currency: "INR", amount: "", rate: "" }] })} /> : null}
        <Text style={type.titleMd}>Quotation preview</Text>
        {previewWidth !== null && previewWidth < LEDGER_WIDTH ? <Text style={type.bodyMuted}>Scroll horizontally to view all seven columns.</Text> : null}
        <Text style={[styles.heading, type.titleMd]}>{draft.customer_name || "RDCL"}</Text>
        <ScrollView horizontal contentContainerStyle={styles.table} onLayout={(event) => setPreviewWidth(event.nativeEvent.layout.width)} testID="furniture-ledger-preview"
          accessibilityLabel="Furniture quotation ledger. Scroll horizontally for more columns." tabIndex={Platform.OS === "web" ? 0 : undefined}
          keyboardShouldPersistTaps="handled" showsHorizontalScrollIndicator
          {...(Platform.OS === "web" ? { onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => handleTableScrollKey(event) } : {})}>
          <View role="table" accessibilityLabel="Furniture quotation ledger">
            <View role="row" style={[styles.tableRow, styles.tableHeader]}>{["RNB", "DESCRIPTION", "RNB", "DESCRIPTION", "AMOUNT", "RATE", "DATE"].map((label, index) => <Text role="columnheader" key={`${label}-${index}`} style={[styles.cell, type.label, styles.darkText]}>{label}</Text>)}</View>
            {Array.from({ length: Math.max(draft.charges.length, draft.deposits.length, 5) }, (_, index) => {
              const charge = draft.charges[index], deposit = draft.deposits[index];
              const dates = [...new Set([charge?.updated_at, deposit?.updated_at].filter((value): value is string => Boolean(value)))].sort();
              return <View role="row" key={index} style={styles.tableRow}>{[charge ? rmbText(chargeCents(charge)) : "", charge?.description || "", deposit ? rmbText(depositCents(deposit)) : "", deposit?.description || "", deposit ? `${deposit.amount} ${furnitureCurrencyLabel(deposit.currency)}` : "", deposit?.rate || "", dates.length ? dates.map(date).join(" / ") : charge || deposit ? "On save" : ""].map((value, cell) => <Text role="cell" key={cell} style={[styles.cell, type.body]}>{value}</Text>)}</View>;
            })}
            <View role="row" style={[styles.tableRow, styles.total]}>{[rmbText(totals!.payable), "", rmbText(totals!.received), "TOTAL", "", "", ""].map((value, index) => <Text role="cell" key={index} testID={index === 0 ? "furniture-total-payable" : index === 2 ? "furniture-total-received" : undefined} style={[styles.cell, styles.darkText, type.label]}>{value}</Text>)}</View>
            <View role="row" style={styles.tableRow}>{["", "", rmbText(totals!.balance), "BALANCE AMOUNT", "", "", ""].map((value, index) => <Text role="cell" key={index} testID={index === 2 ? "furniture-balance" : undefined} style={[styles.cell, type.label, (index === 2 || index === 3) && styles.balance]}>{value}</Text>)}</View>
          </View>
        </ScrollView>
        <View style={styles.card} testID="furniture-summary">
          <Text style={type.body}>Payable RNB {rmbText(totals!.payable)}</Text>
          <Text style={type.body}>Received RNB {rmbText(totals!.received)}</Text>
          <Text style={type.titleMd}>Balance RNB {rmbText(totals!.balance)}</Text>
        </View>
        <View style={styles.actions}>{editable ? <Button label="Save quotation" loading={busy === "save"} disabled={Boolean(busy) || !dirty} onPress={() => void save()} /> : null}
          {editable && !locked ? <Button label="Finalize and lock charges" variant="secondary" disabled={Boolean(busy)} onPress={() => void save(true)} /> : null}
          {canExport ? <Button label="Download PDF" icon="download" variant="secondary" disabled={!saved || dirty || Boolean(busy)} onPress={() => saved && void downloadApiFile(`/furniture-quotations/${saved.id}/pdf`, `${saved.customer_name.replace(/[\\/]/g, "")}.pdf`, "furniture quotation", FURNITURE_FLOOR_ID)} /> : null}
          {canExport ? <Button label="Share PDF file" icon="share" variant="secondary" disabled={!saved || dirty || Boolean(busy)} loading={busy === "share"} onPress={async () => {
            if (!saved || dirty || busy) return;
            const version = requestVersion.current;
            setBusy("share");
            try { await shareApiPdf(`/furniture-quotations/${saved.id}/pdf`, `${saved.customer_name.replace(/[\\/]/g, "")}.pdf`, FURNITURE_FLOOR_ID); }
            finally { if (version === requestVersion.current) setBusy(null); }
          }} testID="share-furniture-quotation-pdf" /> : null}
        </View>
        {canExport ? <View style={styles.card}><TextField label="Accompanying WhatsApp message" multiline value={message} editable={!busy && !receipt} onChangeText={(value) => { setMessage(value); sendKey.current = ""; }} />
          <Text style={type.bodyMuted}>{dirty ? "Save your changes before downloading or sending the PDF." : `PDF and message will be sent to ${formatPhone(saved?.customer_phone) || "the customer"}.`}</Text>
          {configurationError ? <><Alert tone="error" title={configurationError} /><Button label="Retry WhatsApp availability" variant="secondary" onPress={() => setConfigurationAttempt((attempt) => attempt + 1)} /></> : whatsAppConfigured === false ? <Alert tone="info" title="Direct WhatsApp sending needs a WhatsApp Business sender configured in Railway. Use Share PDF file to send the attachment from your device." /> : null}
          {receipt ? <><Text style={type.body}>WhatsApp status: {receipt.status}{receipt.updated_at ? ` · ${date(receipt.updated_at)}` : ""}{receipt.error_code ? ` · ${receipt.error_code}` : ""}</Text><Button label="Refresh delivery status" variant="secondary" loading={busy === "receipt"} disabled={Boolean(busy)} onPress={() => void refreshReceipt()} />
            {receipt.status === "failed" ? <Button label="Prepare another send attempt" variant="secondary" disabled={Boolean(busy)} onPress={() => { sendKey.current = ""; setReceipt(null); setError(null); }} /> : null}</> : null}
          {canSend ? <Button label="Send PDF to WhatsApp" icon="send" loading={busy === "send"} disabled={!saved || dirty || Boolean(busy) || !message.trim() || whatsAppConfigured !== true || Boolean(receipt)} onPress={() => void send()} /> : null}
        </View> : null}
      </>}
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.surface }, content: { padding: spacing.lg, gap: spacing.md, maxWidth: 1100, width: "100%", alignSelf: "center", paddingBottom: spacing.xxl },
  card: { backgroundColor: colors.surface, padding: spacing.lg, borderRadius: radius.lg, gap: spacing.md, borderWidth: 1, borderColor: colors.border },
  actions: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }, table: { paddingBottom: spacing.sm }, tableRow: { flexDirection: "row" },
  cell: { width: LEDGER_COLUMN_WIDTH, flexShrink: 0, minHeight: 48, padding: spacing.sm, borderWidth: 0.5, borderColor: colors.border, ...(Platform.OS === "web" ? { overflowWrap: "anywhere" as any } : {}) }, heading: { textAlign: "center", padding: spacing.md, backgroundColor: colors.surface },
  tableHeader: { backgroundColor: "#c7c9ef" }, total: { backgroundColor: "#fff000" }, balance: { backgroundColor: "#ffaf00", color: "#202020" }, darkText: { color: "#202020" },
});
