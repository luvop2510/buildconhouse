// Settings > Company -- name/tagline/contact/logo. Previously these were
// hardcoded constants (theme/tokens.ts `brand`) with no way to change them
// at all. Editing requires admin+; other roles see a read-only view.
import Feather from "@expo/vector-icons/Feather";
import * as ImagePicker from "expo-image-picker";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { Image, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { api } from "@/src/api/client";
import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { toast } from "@/src/components/Toast";
import { Button, Card, TextField, ErrorState, LoadingState } from "@/src/components/ui";
import { useAuth } from "@/src/state/auth";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type Company = {
  name: string; tagline: string; phone: string; email: string;
  address?: string | null; gstin?: string | null; logo_base64?: string | null;
};

export default function SettingsCompany() {
  const router = useRouter();
  const { staff } = useAuth();
  const canEdit = staff?.role === "owner" || staff?.role === "admin";
  const [form, setForm] = useState<Company | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedForm, setSavedForm] = useState<Company | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const dirty = !!form && JSON.stringify(form) !== JSON.stringify(savedForm);

  const [loadError, setLoadError] = useState(false);
  const load = useCallback(() => {
    setLoadError(false);
    api.get<Company>("/settings/company").then(value => { setForm(value); setSavedForm(value); }).catch(() => setLoadError(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const set = (k: keyof Company) => (v: string) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const pickLogo = async () => {
    // Image-only selection uses the system picker without broad library access.
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ["images"], quality: 0.8, base64: true, allowsEditing: true, aspect: [3, 1],
    });
    if (result.canceled || !result.assets?.[0]?.base64) return;
    const asset = result.assets[0];
    const mime = asset.mimeType || "image/png";
    setForm((f) => (f ? { ...f, logo_base64: `data:${mime};base64,${asset.base64}` } : f));
  };

  const save = async () => {
    if (!form || saving || !canEdit || !dirty) return;
    setSaving(true);
    setSaveError(null);
    try {
      const updated = await api.put<Company>("/settings/company", form);
      setForm(updated);
      setSavedForm(updated);
      toast.show("Company profile saved");
    } catch (e: any) {
      setSaveError(e?.message || "Could not save. Your changes are still here; try again.");
    } finally {
      setSaving(false);
    }
  };

  if (!form) {
    return <AdminPage title="Company" back={() => router.back()}>{loadError ? <ErrorState title="Couldn't load company settings" onRetry={load} /> : <LoadingState label="Loading settings…" />}</AdminPage>;
  }

  return (
    <AdminPage title="Company" subtitle={canEdit ? undefined : "View only -- admin role required to edit"} back={() => router.back()}>
      <View style={{ gap: spacing.lg }}>
        <Card style={{ alignItems: "center", gap: spacing.sm }}>
          {form.logo_base64 ? (
            <Image source={{ uri: form.logo_base64 }} style={{ width: 160, height: 54, borderRadius: radius.sm }} resizeMode="contain" />
          ) : (
            <View style={{ width: 160, height: 54, borderRadius: radius.sm, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" }}>
              <Feather name="image" size={20} color={colors.onSurfaceMuted} />
            </View>
          )}
          {canEdit ? (
            <Button testID="pick-logo-btn" label="Change logo" icon="upload" size="sm" variant="secondary" onPress={pickLogo} />
          ) : null}
          <Text style={type.caption}>Shown in-app only for now -- quotation PDFs keep their existing printed header.</Text>
        </Card>

        <Card style={{ gap: spacing.md }}>
          <TextField testID="company-name-input" label="Company name" value={form.name} onChangeText={set("name")} editable={canEdit && !saving} />
          <TextField testID="company-tagline-input" label="Tagline" value={form.tagline} onChangeText={set("tagline")} editable={canEdit && !saving} />
          <TextField testID="company-phone-input" label="Phone" value={form.phone} onChangeText={set("phone")} editable={canEdit && !saving} keyboardType="phone-pad" />
          <TextField testID="company-email-input" label="Email" value={form.email} onChangeText={set("email")} editable={canEdit && !saving} keyboardType="email-address" autoCapitalize="none" />
          <TextField testID="company-address-input" label="Address (optional)" value={form.address || ""} onChangeText={set("address")} editable={canEdit && !saving} multiline />
          <TextField testID="company-gstin-input" label="GSTIN (optional)" value={form.gstin || ""} onChangeText={set("gstin")} editable={canEdit && !saving} autoCapitalize="characters" />
        </Card>

        {canEdit ? (
          <View style={{ gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md }}>
            {saveError ? <Text accessibilityRole="alert" style={[type.body, { color: colors.error }]}>{saveError}</Text> : null}
            <Text accessibilityLiveRegion="polite" style={type.caption}>{saving ? "Saving changes…" : dirty ? "You have unsaved changes" : "All changes saved"}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
              <Button testID="save-company-btn" label="Save changes" icon="check" loading={saving} disabled={!dirty || saving} onPress={save} />
              <Button label="Discard changes" variant="secondary" disabled={!dirty || saving} onPress={() => { setForm(savedForm); setSaveError(null); }} />
            </View>
          </View>
        ) : null}
      </View>
    </AdminPage>
  );
}
