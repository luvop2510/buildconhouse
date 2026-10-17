import { useEffect, useRef, useState } from "react";
import { View } from "react-native";

import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { Alert, Button, TextField } from "@/src/components/ui";
import { BottomSheet } from "@/src/components/BottomSheet";
import { shareApiPdf } from "@/src/utils/downloadFile";
import { defaultQuotationMessage, quotationPdfPath } from "@/src/utils/quotationWhatsApp";
import { spacing, type } from "@/src/theme/tokens";

type DeliveryReceipt = { status: string; updated_at?: string; error_code?: string };
export type WhatsAppQuotationDraft = {
  id: string; floor_id: string; phone: string | null; customer_name: string; filename: string;
  expected_updated_at: string; include_dimensions: boolean; direct_send_configured: boolean;
};

export async function prepareQuotationWhatsAppDraft(id: string, floorId: string, includeDimensions = false): Promise<WhatsAppQuotationDraft> {
  return api.post<WhatsAppQuotationDraft>(`/quotations/${encodeURIComponent(id)}/whatsapp-draft?include_dimensions=${includeDimensions}`, undefined, { floorId });
}

export function WhatsAppQuotationSheet({ draft, onClose }: {
  draft: WhatsAppQuotationDraft | null; onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<DeliveryReceipt | null>(null);
  const requestKey = useRef("");
  const activeDraft = useRef(draft);
  activeDraft.current = draft;
  useEffect(() => {
    setMessage(draft ? defaultQuotationMessage(draft.customer_name) : "");
    setError(null); setReceipt(null); setBusy(false); requestKey.current = "";
  }, [draft]);

  const send = async () => {
    if (!draft || busy || receipt || !message.trim() || !draft.direct_send_configured || !draft.phone) return;
    setBusy(true); setError(null);
    if (!requestKey.current) requestKey.current = `quotation_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
    try {
      const result = await api.post<DeliveryReceipt>(`/quotations/${encodeURIComponent(draft.id)}/whatsapp-send`, {
        message: message.trim(), expected_updated_at: draft.expected_updated_at,
        idempotency_key: requestKey.current, include_dimensions: draft.include_dimensions,
      }, { floorId: draft.floor_id });
      if (activeDraft.current === draft) setReceipt(result);
    } catch (failure: any) {
      if (activeDraft.current === draft) {
        // An interrupted response may already have reached the provider. Keep
        // this request ID and check its receipt before allowing another send.
        setReceipt({ status: "unknown" });
        setError(typeof failure?.detail === "string" ? failure.detail : "Delivery is unconfirmed. Refresh the status before trying again.");
      }
    } finally { if (activeDraft.current === draft) setBusy(false); }
  };
  const refresh = async () => {
    if (!draft || busy || !requestKey.current) return;
    setBusy(true); setError(null);
    try {
      const result = await api.get<DeliveryReceipt>(`/whatsapp/deliveries/${encodeURIComponent(draft.id)}/${encodeURIComponent(requestKey.current)}`, { floorId: draft.floor_id });
      if (activeDraft.current === draft) setReceipt(result);
    } catch (failure: any) {
      if (activeDraft.current === draft) setError(typeof failure?.detail === "string" ? failure.detail : "Could not refresh delivery status.");
    } finally { if (activeDraft.current === draft) setBusy(false); }
  };

  return <BottomSheet visible={!!draft} onClose={() => { if (!busy) onClose(); }} title="Share PDF" testID="quotation-whatsapp-sheet">
    <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
      {error ? <Alert tone="error" title={error} /> : null}
      <Text style={type.bodyStrong}>{draft?.customer_name}{draft?.phone ? ` · +${draft.phone}` : ""}</Text>
      <Text style={type.bodyMuted}>Share the PDF attachment with the customer.</Text>
      <Button label="Share PDF file" icon="share" variant="secondary" disabled={busy} onPress={async () => {
        if (!draft || busy) return;
        setBusy(true);
        try { await shareApiPdf(quotationPdfPath(draft.id, draft.include_dimensions), draft.filename, draft.floor_id); }
        finally { if (activeDraft.current === draft) setBusy(false); }
      }} testID="share-quotation-pdf-file" />
      {draft?.direct_send_configured && draft.phone ? <>
        <TextField label="Message" value={message} onChangeText={setMessage} multiline maxLength={1024} editable={!busy && !receipt} testID="quotation-whatsapp-message" />
        <Button label="Send PDF to WhatsApp" icon="send" onPress={() => void send()} disabled={!message.trim() || busy || !!receipt} loading={busy} testID="send-quotation-pdf-whatsapp" />
      </> : <Text style={type.bodyMuted}>{!draft?.phone ? "Add a valid customer WhatsApp number to enable direct delivery." : "Direct WhatsApp delivery is unavailable. Use Share PDF file to send the attachment from your device."}</Text>}
      {receipt ? <>
        <Text style={type.body}>{receipt.status === "accepted" ? "PDF submitted to WhatsApp" : `PDF delivery: ${receipt.status}`}{receipt.error_code ? ` · ${receipt.error_code}` : ""}</Text>
        <Button label="Refresh delivery status" variant="secondary" disabled={busy} onPress={() => void refresh()} testID="refresh-quotation-pdf-status" />
      </> : null}
    </View>
  </BottomSheet>;
}
