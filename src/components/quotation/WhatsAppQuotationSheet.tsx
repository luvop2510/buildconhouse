import { useEffect, useRef, useState } from "react";
import { Linking, Platform, View } from "react-native";

import { api } from "@/src/api/client";
import { Text } from "@/src/components/AppText";
import { Alert, Button, TextField } from "@/src/components/ui";
import { BottomSheet } from "@/src/components/BottomSheet";
import { downloadApiFile } from "@/src/utils/downloadFile";
import { defaultQuotationMessage, quotationWhatsAppUrl } from "@/src/utils/quotationWhatsApp";
import { spacing, type } from "@/src/theme/tokens";

export type WhatsAppQuotationDraft = {
  phone: string; customer_name: string; pdf_path: string; filename: string;
  expires_at: string; expires_in: number;
};

export async function prepareQuotationWhatsAppDraft(id: string, floorId: string, includeDimensions = false): Promise<WhatsAppQuotationDraft> {
  return api.post<WhatsAppQuotationDraft>(`/quotations/${encodeURIComponent(id)}/whatsapp-draft?include_dimensions=${includeDimensions}`, undefined, { floorId });
}

/** The fresh Open WhatsApp tap preserves browser activation after PDF rendering. */
export function WhatsAppQuotationSheet({ draft, onClose, onRevoke }: {
  draft: WhatsAppQuotationDraft | null; onClose: () => void; onRevoke: () => Promise<void>;
}) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState(false);
  const activeDraft = useRef(draft);
  activeDraft.current = draft;
  useEffect(() => { setMessage(draft ? defaultQuotationMessage(draft.customer_name) : ""); setError(null); }, [draft]);

  const open = () => {
    if (!draft) return;
    try {
      if (Date.parse(draft.expires_at) <= Date.now()) throw new Error("This PDF link has expired. Close this draft and prepare a new one.");
      const base = Platform.OS === "web" ? new URL(api.base || "/", window.location.origin).href : api.base;
      const pdfUrl = new URL(draft.pdf_path, base).href;
      const url = quotationWhatsAppUrl(draft.phone, message, pdfUrl);
      if (Platform.OS === "web") {
        // Navigation happens synchronously in this tap, avoiding popup blockers.
        const anchor = document.createElement("a");
        anchor.href = url; anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
        document.body.appendChild(anchor); anchor.click(); anchor.remove();
      } else {
        void Linking.openURL(url).catch(() => {
          if (activeDraft.current === draft) setError("Could not open WhatsApp. Check that it is installed and try again.");
        });
      }
    } catch (failure: any) { setError(failure?.message || "Could not open WhatsApp."); }
  };

  return <BottomSheet visible={!!draft} onClose={() => { if (!revoking) onClose(); }} title="WhatsApp quotation draft" testID="quotation-whatsapp-sheet">
    <View style={{ gap: spacing.md, paddingBottom: spacing.lg }}>
      {error ? <Alert tone="error" title={error} /> : null}
      <Text style={type.bodyStrong}>{draft?.customer_name} · +{draft?.phone}</Text>
      <TextField label="Message" value={message} onChangeText={setMessage} multiline testID="quotation-whatsapp-message" />
      <Text style={type.bodyMuted}>The message includes a private PDF link valid for 24 hours. Anyone with the link can open this quotation. Review and send it in WhatsApp; opening this draft does not mark the quotation as sent.</Text>
      <Button label="Open WhatsApp draft" icon="message-circle" onPress={open} disabled={!message.trim() || revoking} testID="open-quotation-whatsapp" />
      <Button label="Download PDF to attach manually" icon="download" variant="secondary" disabled={revoking} onPress={() => {
        if (draft) void downloadApiFile(draft.pdf_path.replace(/^\/api/, ""), draft.filename, "quotation PDF");
      }} testID="download-whatsapp-quotation" />
      <Button label="Revoke quotation PDF links" icon="x-circle" variant="secondary" loading={revoking} disabled={revoking} onPress={async () => {
        setRevoking(true); setError(null);
        try { await onRevoke(); onClose(); }
        catch (failure: any) { setError(failure?.detail || "Could not revoke this PDF link. Try again."); }
        finally { setRevoking(false); }
      }} testID="revoke-quotation-whatsapp" />
    </View>
  </BottomSheet>;
}
