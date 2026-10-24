import { Disclosure } from "@/src/design/Disclosure";
// Add Customer — create-customer form. Was previously missing: the
// "Add Customer" button on the list screen navigated to this route with no
// screen backing it (Expo Router's [id].tsx would have caught "new" as a
// literal customer id and tried to fetch a workspace for a nonexistent
// customer). Backend already fully supports POST /customers — this screen
// was simply never built. DS-aligned with the rest of this folder
// (theme/tokens + components/ui, matching customers/index.tsx + [id].tsx).
import { useRouter } from "expo-router";
import { useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { api } from "@/src/api/client";
import {
  Alert, Button, PageHeader, TextField,
} from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { ReferrerField } from "@/src/components/customer/ReferrerField";
import { useBp } from "@/src/design/responsive";
import { colors, spacing } from "@/src/theme/tokens";

export default function NewCustomer() {
  const router = useRouter();
  const { isPhone, gutter } = useBp();
  const [saving, setSaving] = useState(false);
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
  const [referrer, setReferrer] = useState<{ id: string; name: string; type: "architect" | "interior_designer" } | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!name.trim()) {
      setError("Name is required");
      toast.error("Enter a customer name");
      return;
    }
    if (saving) return;
    setSaveError(null);
    setSaving(true);
    try {
      const payload = {
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
        referrer_id: referrer?.id || null,
      };
      const created = await api.post<{ id: string }>("/customers", payload);
      toast.success("Customer added");
      router.replace(`/(admin)/customers/${created.id}` as any);
    } catch (e: any) {
      setSaveError(e?.detail || "Could not save customer. Your entries are still here.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: colors.surface }} edges={isPhone ? [] : ["top"]}>
      <KeyboardAvoidingView
        enabled={Platform.OS !== "web"}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1 }}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <ScrollView
          contentContainerStyle={{ width: "100%", maxWidth: 720, alignSelf: "center", paddingHorizontal: gutter, paddingTop: isPhone ? spacing.lg : spacing.xl, gap: spacing.lg, paddingBottom: spacing.xxxl }}
          keyboardShouldPersistTaps="handled"
        >
          <PageHeader title="Add Customer" overline="CRM" back={() => router.back()} embedded />
          <TextField
            label="Name *"
            placeholder="e.g. Rajesh Malhotra"
            value={name}
            onChangeText={(v) => { setName(v); setError(null); }}
            error={error}
            autoFocus
            testID="new-customer-name"
          />
          <TextField
            label="Phone"
            placeholder="+91 98xxxxxxxx"
            value={phone}
            onChangeText={setPhone}
            keyboardType="phone-pad"
            testID="new-customer-phone"
          />
          <Disclosure title="Additional customer details">
          <ReferrerField value={referrer} onChange={setReferrer} />
          <TextField
            label="Company"
            placeholder="Business name (optional)"
            value={company}
            onChangeText={setCompany}
            testID="new-customer-company"
          />
          <TextField
            label="Email"
            placeholder="name@example.com"
            value={email}
            onChangeText={setEmail}
            autoCapitalize="none"
            keyboardType="email-address"
            testID="new-customer-email"
          />
          <TextField
            label="City"
            placeholder="e.g. Ahmedabad"
            value={city}
            onChangeText={setCity}
            testID="new-customer-city"
          />
          <TextField label="Property / project" placeholder="e.g. Riverfront Residence" value={propertyName} onChangeText={setPropertyName} testID="new-customer-property-name" />
          <TextField
            label="Address"
            placeholder="Street, area, pincode"
            value={address}
            onChangeText={setAddress}
            multiline
            numberOfLines={3}
            style={{ minHeight: 72, textAlignVertical: "top" }}
            testID="new-customer-address"
          />
          <View style={{ flexDirection: isPhone ? "column" : "row", gap: spacing.sm }}>
            <TextField
              label="State"
              placeholder="e.g. Gujarat"
              value={stateField}
              onChangeText={setStateField}
              containerStyle={{ flex: 1 }}
              testID="new-customer-state"
            />
            <TextField
              label="Pincode"
              placeholder="6-digit"
              value={pincode}
              onChangeText={setPincode}
              keyboardType="number-pad"
              containerStyle={{ flex: 1 }}
              testID="new-customer-pincode"
            />
          </View>
          <TextField
            label="GSTIN"
            placeholder="Optional, for invoicing"
            value={gstin}
            onChangeText={setGstin}
            autoCapitalize="characters"
            testID="new-customer-gstin"
          />


          </Disclosure>
        </ScrollView>
        <View style={{ width: "100%", maxWidth: 760, alignSelf: "center", paddingHorizontal: gutter, paddingVertical: spacing.lg, gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.surfaceSecondary }}>
          {saveError ? <Alert tone="error" title={saveError} /> : null}
          <Button
            label={saving ? "Saving…" : "Save Customer"}
            variant="primary"
            size="lg"
            icon="check"
            disabled={saving}
            loading={saving}
            fullWidth
            onPress={save}
            testID="new-customer-save"
          />
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
