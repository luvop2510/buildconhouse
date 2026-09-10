// Customers > Edit Customer — name/phone/email + Portal Enabled toggle +
// Send Invite + Reset Password. DS-aligned with customers/new.tsx (same
// theme/tokens + components/ui convention). Portal actions (Send Invite /
// Reset Password) require Portal Enabled = On AND an email on file — the
// backend enforces this too; the UI just mirrors it so buttons are visibly
// disabled instead of erroring after a tap.
import { useRouter, useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import {
  KeyboardAvoidingView, Platform, ScrollView, Switch, Text, View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import {
  Button, Card, Chip, PageHeader, TextField, ErrorState,
} from "@/src/components/ui";
import { ConfirmDialog } from "@/src/components/ds";
import { TempPasswordDialog, TempPasswordResult } from "@/src/components/TempPasswordDialog";
import { toast } from "@/src/components/Toast";
import { ReferrerField } from "@/src/components/customer/ReferrerField";
import { useBp } from "@/src/design/responsive";
import { useAuth } from "@/src/state/auth";
import { canManageDestructiveData } from "@/src/constants/roles";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type Tier = "retail" | "trade" | "vip";
type Customer = {
  id: string; name: string; company?: string | null; email?: string | null;
  phone?: string | null; city?: string | null; address?: string | null;
  property_name?: string | null;
  state?: string | null; pincode?: string | null;
  gstin?: string | null; tier: Tier; notes?: string | null; portal_enabled: boolean;
  referrer_id?: string | null; referrer_name?: string | null; referrer_type?: "architect" | "interior_designer" | null;
};

export default function EditCustomer() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { isPhone, gutter } = useBp();
  const { staff } = useAuth();

  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [name, setName] = useState("");
  const [company, setCompany] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [city, setCity] = useState("");
  const [address, setAddress] = useState("");
  const [propertyName, setPropertyName] = useState("");
  const [stateField, setStateField] = useState("");
  const [pincode, setPincode] = useState("");
  const [gstin, setGstin] = useState("");
  const [tier, setTier] = useState<Tier>("retail");
  const [referrer, setReferrer] = useState<{ id: string; name: string; type: "architect" | "interior_designer" } | null>(null);
  const [notes, setNotes] = useState("");
  const [portalEnabled, setPortalEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [tempResult, setTempResult] = useState<TempPasswordResult | null>(null);
  const [tempDialogOpen, setTempDialogOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoadError(false);
    setLoaded(false);
    try {
    const c = await api.get<Customer>(`/customers/${id}`);
    setName(c.name || "");
    setCompany(c.company || "");
    setEmail(c.email || "");
    setPhone(c.phone || "");
    setCity(c.city || "");
    setAddress(c.address || "");
    setPropertyName(c.property_name || "");
    setStateField(c.state || "");
    setPincode(c.pincode || "");
    setGstin(c.gstin || "");
    setTier(c.tier || "retail");
    setReferrer(c.referrer_id && c.referrer_name && c.referrer_type ? { id: c.referrer_id, name: c.referrer_name, type: c.referrer_type } : null);
    setNotes(c.notes || "");
    setPortalEnabled(!!c.portal_enabled);
    setLoaded(true);
    } catch { setLoadError(true); }
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const deleteCustomer = useCallback(async () => {
    if (!id) return;
    setDeleting(true);
    try {
      await api.delete(`/customers/${id}`);
      toast.success("Customer deleted");
      router.replace("/(admin)/customers" as any);
    } catch (e: any) {
      toast.error(e?.detail || "Could not delete customer");
    } finally {
      setDeleting(false);
    }
  }, [id, router]);

  const canUsePortalActions = portalEnabled && !!email.trim();

  const save = async (silent = false) => {
    if (!name.trim()) { setError("Name is required"); if (!silent) toast.error("Enter a customer name"); return false; }
    if (portalEnabled && !email.trim()) { setError("Add an email to enable portal access"); toast.error("Email required for portal access"); return false; }
    setSaving(true);
    try {
      await api.patch(`/customers/${id}`, {
        name: name.trim(),
        company: company.trim() || null,
        email: email.trim() || null,
        phone: phone.trim() || null,
        city: city.trim() || null,
        address: address.trim() || null,
        property_name: propertyName.trim() || null,
        state: stateField.trim() || null,
        pincode: pincode.trim() || null,
        gstin: gstin.trim() || null,
        tier,
        referrer_id: referrer?.id || null,
        notes: notes.trim() || null,
        portal_enabled: portalEnabled,
      });
      if (!silent) toast.success("Customer updated");
      return true;
    } catch (e: any) {
      if (!silent) toast.error(e?.detail || "Could not save customer");
      setError(e?.detail || null);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const sendInvite = async () => {
    // Persist any pending edits (e.g. they just typed the email + flipped
    // the toggle) before asking the backend to issue credentials.
    const ok = await save(true);
    if (!ok) return;
    setInviting(true);
    try {
      const res = await api.post<TempPasswordResult>(`/customers/${id}/send-invite`);
      setTempResult(res);
      setTempDialogOpen(true);
    } catch (e: any) {
      toast.error(e?.detail || "Could not send invite");
    } finally {
      setInviting(false);
    }
  };

  const resetPassword = async () => {
    setResetting(true);
    try {
      const res = await api.post<TempPasswordResult>(`/customers/${id}/reset-password`);
      setTempResult(res);
      setTempDialogOpen(true);
    } catch (e: any) {
      toast.error(e?.detail || "Could not reset password");
    } finally {
      setResetting(false);
    }
  };

  if (!loaded) return <View style={{ flex: 1, padding: gutter, backgroundColor: colors.surface }}>
    {loadError ? <ErrorState title="Couldn't load customer" subtitle="Check your connection and try again." onRetry={load} /> : <Text accessibilityLiveRegion="polite">Loading customer…</Text>}
  </View>;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      <PageHeader
        title="Edit Customer"
        overline="CRM"
        back={() => router.back()}
        actions={canManageDestructiveData(staff?.role) ? (
          <Button
            label="Delete"
            icon="trash-2"
            variant="danger"
            size="sm"
            onPress={() => setDeleteOpen(true)}
            testID="delete-customer-edit"
          />
        ) : undefined}
      />
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <ScrollView
          contentContainerStyle={{ width: "100%", maxWidth: 720, alignSelf: "center", paddingHorizontal: gutter, paddingTop: isPhone ? spacing.lg : spacing.xl, gap: spacing.lg, paddingBottom: spacing.xxxl }}
          keyboardShouldPersistTaps="handled"
        >
          <TextField
            label="Name *"
            value={name}
            onChangeText={(v) => { setName(v); setError(null); }}
            error={error}
            testID="edit-customer-name"
          />
          <TextField label="Company" value={company} onChangeText={setCompany} testID="edit-customer-company" />
          <TextField
            label="Email"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            helper="Required for portal access"
            testID="edit-customer-email"
          />
          <TextField label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" testID="edit-customer-phone" />
          <TextField label="City" value={city} onChangeText={setCity} testID="edit-customer-city" />
          <TextField label="Property / project" value={propertyName} onChangeText={setPropertyName} placeholder="e.g. Riverfront Residence" testID="edit-customer-property-name" />
          <TextField label="Address" value={address} onChangeText={setAddress} multiline numberOfLines={3} style={{ minHeight: 72, textAlignVertical: "top" }} testID="edit-customer-address" />
          <View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.sm }}>
            <TextField label="State" value={stateField} onChangeText={setStateField} containerStyle={{ flex: 1 }} testID="edit-customer-state" />
            <TextField label="Pincode" value={pincode} onChangeText={setPincode} keyboardType="number-pad" containerStyle={{ flex: 1 }} testID="edit-customer-pincode" />
          </View>
          <TextField label="GSTIN" value={gstin} onChangeText={setGstin} autoCapitalize="characters" testID="edit-customer-gstin" />
          <ReferrerField value={referrer} onChange={setReferrer} />
          <TextField label="Notes" value={notes} onChangeText={setNotes} multiline numberOfLines={2} style={{ minHeight: 56, textAlignVertical: "top" }} testID="edit-customer-notes" />

          <View style={{ gap: 6 }}>
            <Text style={type.label}>Tier</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
              {(["retail", "trade", "vip"] as Tier[]).map((t) => (
                <Chip key={t} label={t.charAt(0).toUpperCase() + t.slice(1)} active={tier === t} onPress={() => setTier(t)} testID={`edit-customer-tier-${t}`} />
              ))}
            </View>
          </View>

          <Button testID="edit-customer-save" label={saving ? "Saving…" : "Save changes"} variant="primary" size="lg" icon="check" disabled={saving} onPress={() => save()} fullWidth />

          {/* Customer Portal */}
          <Card style={{ gap: spacing.md, marginTop: spacing.sm }}>
            <Text style={type.overline}>Customer Portal</Text>

            <View style={styles.switchRow}>
              <View style={{ flex: 1 }}>
                <Text style={type.bodyStrong}>Portal access</Text>
                <Text style={type.caption}>
                  {portalEnabled ? "This customer can sign into the Customer Portal." : "Portal sign-in is disabled for this customer."}
                </Text>
              </View>
              <Switch testID="edit-customer-portal-switch" value={portalEnabled} onValueChange={setPortalEnabled} />
            </View>

            {!email.trim() && portalEnabled ? (
              <Text style={[type.caption, { color: colors.error }]}>Add an email above, then save, before sending an invite.</Text>
            ) : null}

            <Button
              testID="edit-customer-send-invite"
              label={inviting ? "Generating…" : "Send Invite"}
              variant="secondary"
              icon="send"
              disabled={inviting || !canUsePortalActions}
              onPress={sendInvite}
              fullWidth
            />
            <Button
              testID="edit-customer-reset-password"
              label={resetting ? "Generating…" : "Reset Password"}
              variant="secondary"
              icon="key"
              disabled={resetting || !canUsePortalActions}
              onPress={resetPassword}
              fullWidth
            />
            <Text style={type.caption}>
              Both generate a temporary password shown once — share it with the customer directly.
              Turn on Portal access and save with an email to enable these.
            </Text>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>

      <TempPasswordDialog
        visible={tempDialogOpen}
        onClose={() => { setTempDialogOpen(false); setTempResult(null); }}
        title="Customer Portal credential"
        result={tempResult}
      />
      <ConfirmDialog
        visible={deleteOpen}
        onClose={() => { if (!deleting) setDeleteOpen(false); }}
        onConfirm={deleteCustomer}
        title="Delete customer?"
        description="This removes the customer and disposable sales-workflow records. Purchase orders and completed payments protect the customer from deletion."
        confirmLabel="Delete"
        tone="danger"
        loading={deleting}
        testID="confirm-delete-customer-edit"
      />
    </SafeAreaView>
  );
}

const styles = {
  switchRow: {
    flexDirection: "row" as const,
    alignItems: "center" as const,
    gap: spacing.md,
    backgroundColor: colors.surfaceTertiary,
    borderRadius: radius.md,
    padding: spacing.md,
  },
};
