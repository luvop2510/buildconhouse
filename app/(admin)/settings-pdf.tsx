// Settings > PDF -- footer text, watermark on/off, an appended terms line,
// and an appended signatory line. Deliberately does NOT touch the item
// table, discount math, or page layout of the quotation PDF -- see the
// comment block on pdf_generator.build_quotation_pdf for the exact scope.
// Every default below matches what was previously hardcoded, so leaving
// this screen untouched changes nothing about existing PDFs.
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Switch, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { api } from "@/src/api/client";
import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { toast } from "@/src/components/Toast";
import { Button, Card, TextField, ErrorState, LoadingState } from "@/src/components/ui";
import { useAuth } from "@/src/state/auth";
import { colors, spacing, type } from "@/src/theme/tokens";

type PDFSettings = {
  footer_company_name: string; footer_phone: string; footer_email: string; footer_tagline: string;
  terms_text?: string | null; signature_name?: string | null; signature_title?: string | null;
  show_watermark: boolean;
};

export default function SettingsPDF() {
  const router = useRouter();
  const { staff } = useAuth();
  const canEdit = staff?.role === "owner" || staff?.role === "admin";
  const [form, setForm] = useState<PDFSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedForm, setSavedForm] = useState<PDFSettings | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = !!form && JSON.stringify(form) !== JSON.stringify(savedForm);

  const [loadError, setLoadError] = useState(false);
  const load = useCallback(() => {
    setLoadError(false);
    api.get<PDFSettings>("/settings/pdf").then(value => { setForm(value); setSavedForm(value); }).catch(() => setLoadError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k: keyof PDFSettings) => (v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    if (!form || saving || !canEdit || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.put<PDFSettings>("/settings/pdf", form);
      setForm(updated);
      setSavedForm(updated);
      toast.show("PDF settings saved");
    } catch (e: any) {
      setSaveError(e?.message || "Could not save. Your changes are still here; try again.");
    } finally {
      setSaving(false);
    }
  };

  if (!form) {
    return <AdminPage title="PDF" back={() => router.back()}>{loadError ? <ErrorState title="Couldn't load pdf settings" onRetry={load} /> : <LoadingState label="Loading settings…" />}</AdminPage>;
  }

  return (
    <AdminPage title="PDF branding" subtitle={canEdit ? "Footer and terms shown on every quotation PDF" : "View only -- admin role required to edit"} back={() => router.back()}>
      <View style={{ gap: spacing.lg }}>
        <Card style={{ gap: spacing.md }}>
          <Text style={type.overline}>Footer</Text>
          <TextField testID="pdf-footer-name-input" label="Company name" value={form.footer_company_name} onChangeText={set("footer_company_name")} editable={canEdit && !saving} />
          <TextField testID="pdf-footer-phone-input" label="Phone" value={form.footer_phone} onChangeText={set("footer_phone")} editable={canEdit && !saving} keyboardType="phone-pad" />
          <TextField testID="pdf-footer-email-input" label="Email" value={form.footer_email} onChangeText={set("footer_email")} editable={canEdit && !saving} keyboardType="email-address" autoCapitalize="none" />
          <TextField testID="pdf-footer-tagline-input" label="Tagline" value={form.footer_tagline} onChangeText={set("footer_tagline")} editable={canEdit && !saving} />
        </Card>

        <Card style={{ gap: spacing.md }}>
          <Text style={type.overline}>Terms and signature</Text>
          <TextField testID="pdf-terms-input" label="Additional terms (optional)" helper="Appended below the existing standard terms -- doesn't replace them" value={form.terms_text || ""} onChangeText={set("terms_text")} editable={canEdit && !saving} multiline />
          <TextField testID="pdf-signature-name-input" label="Authorized signatory name (optional)" value={form.signature_name || ""} onChangeText={set("signature_name")} editable={canEdit && !saving} />
          <TextField testID="pdf-signature-title-input" label="Signatory title (optional)" value={form.signature_title || ""} onChangeText={set("signature_title")} editable={canEdit && !saving} />
        </Card>

        <Card style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.md }}>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={type.bodyStrong}>Show watermark</Text>
            <Text style={type.caption}>The rotated logo watermark on itemised pages</Text>
          </View>
          <Switch
            testID="pdf-watermark-switch"
            value={form.show_watermark}
            onValueChange={(v) => { if (canEdit) setForm((f) => (f ? { ...f, show_watermark: v } : f)); }}
            disabled={!canEdit}
            trackColor={{ false: colors.border, true: colors.brand }}
          />
        </Card>

        {canEdit ? (
          <View style={{ gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md }}>
            {saveError ? <Text accessibilityRole="alert" style={[type.body, { color: colors.error }]}>{saveError}</Text> : null}
            <Text accessibilityLiveRegion="polite" style={type.caption}>{saving ? "Saving changes…" : dirty ? "You have unsaved changes" : "All changes saved"}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
              <Button testID="save-pdf-settings-btn" label="Save changes" icon="check" loading={saving} disabled={!dirty || saving} onPress={save} />
              <Button label="Discard changes" variant="secondary" disabled={!dirty || saving} onPress={() => { setForm(savedForm); setSaveError(null); }} />
            </View>
          </View>
        ) : null}
      </View>
    </AdminPage>
  );
}
