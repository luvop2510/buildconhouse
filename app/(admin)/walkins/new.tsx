import { Disclosure } from "@/src/design/Disclosure";
// Log Walk-in — Phase 4 (2026-07-30), extended for the CRM Foundation spec
// (2026-08): full Customer capture (address/city/state/pincode), explicit
// Salesperson assignment (never silent), separate Reference/Architect/
// Builder fields (distinct from Lead Source), and confidence-tiered
// duplicate detection (high = auto-link, medium = staff must resolve via a
// picker sheet, low = soft non-blocking hint). Matches customers/new.tsx
// pattern for the Customer-level fields.
import { useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, View } from "react-native";
import { Text } from "@/src/components/AppText";
import { SafeAreaView } from "react-native-safe-area-context";

import { type CustomerMatch, type DuplicateMatches, parseDuplicateConflict, walkinsApi } from "@/src/api/walkins";
import { toast } from "@/src/components/Toast";
import {
  Alert, Avatar, Button, Card, Chip, ListRow, PageHeader, SearchField, Sheet, TextField,
} from "@/src/components/ui";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useBp } from "@/src/design/responsive";
import { useAuth } from "@/src/state/auth";
import { colors, spacing, type } from "@/src/theme/tokens";

type Assignee = { id: string; full_name: string; role: string };

export default function NewWalkIn() {
  const router = useRouter();
  const { isPhone } = useBp();
  const { floor_id: routeFloorId } = useLocalSearchParams<{ floor_id?: string }>();
  const { staff } = useAuth();
  const { floors, selectedFloorId } = useFloorAccess();
  const [optionsError, setOptionsError] = useState(false);
  const [optionsRetry, setOptionsRetry] = useState(0);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [altPhone, setAltPhone] = useState("");
  const [email, setEmail] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [pincode, setPincode] = useState("");

  const [budget, setBudget] = useState("");
  const [notes, setNotes] = useState("");
  const [products, setProducts] = useState("");
  const [source, setSource] = useState("Walk-in");
  const [sources, setSources] = useState<string[]>(["Walk-in", "Reference", "Architect", "Builder", "Social Media", "Existing Customer", "Other"]);
  const [referenceContact, setReferenceContact] = useState("");
  const [architect, setArchitect] = useState("");
  const [builder, setBuilder] = useState("");
  const [floorId, setFloorId] = useState(routeFloorId || selectedFloorId || floors[0]?.id || "");
  const [error, setError] = useState<string | null>(null);

  // Salesperson — explicit, required, defaults to the logged-in staff but
  // always editable before saving (never a silent assignment).
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [salespersonId, setSalespersonId] = useState<string>(staff?.id || "");
  const [salespersonName, setSalespersonName] = useState<string>(staff?.full_name || "");
  const [spSheetOpen, setSpSheetOpen] = useState(false);
  const [spSearch, setSpSearch] = useState("");

  // Duplicate detection — confidence-tiered.
  const [matches, setMatches] = useState<DuplicateMatches>({ high: [], medium: [], low: [] });
  const [resolvedCustomerId, setResolvedCustomerId] = useState<string | null>(null); // "Use Existing" chosen
  const [forceNew, setForceNew] = useState(false); // "Create New Anyway" chosen
  const [dupSheetOpen, setDupSheetOpen] = useState(false);

  useEffect(() => {
    setOptionsError(false);
    walkinsApi.listSources().then((r) => setSources(r.sources)).catch(() => setOptionsError(true));
    walkinsApi.listAssignees().then(setAssignees).catch(() => setOptionsError(true));
  }, [optionsRetry]);

  useEffect(() => {
    if (!salespersonId && staff?.id) { setSalespersonId(staff.id); setSalespersonName(staff.full_name); }
  }, [staff, salespersonId]);

  useEffect(() => {
    if (routeFloorId) { setFloorId(routeFloorId); return; }
    if (!floorId && (selectedFloorId || floors[0]?.id)) setFloorId(selectedFloorId || floors[0]?.id);
  }, [routeFloorId, selectedFloorId, floors, floorId]);

  useEffect(() => {
    const digits = phone.replace(/\D/g, "");
    const hasSignal = digits.length >= 10 || email.trim().length >= 5 || name.trim().length >= 3;
    setResolvedCustomerId(null);
    setForceNew(false);
    if (!hasSignal) { setMatches({ high: [], medium: [], low: [] }); return; }
    let active = true;
    const t = setTimeout(() => {
      walkinsApi.checkDuplicate({ phone, alternatePhone: altPhone, email, name, city, address })
        .then((r) => {
          if (active) setMatches(r);
        })
        .catch(() => {});
    }, 450);
    return () => { active = false; clearTimeout(t); };
  }, [phone, altPhone, email, name, city, address]);

  const resolvedHigh = matches.high[0] || null;

  const filteredAssignees = useMemo(() => {
    const q = spSearch.trim().toLowerCase();
    if (!q) return assignees;
    return assignees.filter((a) => a.full_name.toLowerCase().includes(q));
  }, [assignees, spSearch]);

  const pickSalesperson = (a: Assignee) => {
    setSalespersonId(a.id); setSalespersonName(a.full_name); setSpSheetOpen(false); setSpSearch("");
  };

  const linkExistingCustomer = (c: CustomerMatch) => {
    setResolvedCustomerId(c.id); setForceNew(false); setDupSheetOpen(false);
    toast.success(`Will link this walk-in to ${c.name}`);
  };
  const viewExistingCustomer = (customerId: string) => {
    setDupSheetOpen(false);
    router.push(`/(admin)/customers/${customerId}` as any);
  };
  const createNewAnyway = () => {
    setForceNew(true); setResolvedCustomerId(null); setDupSheetOpen(false);
  };

  const submit = async (useExistingId?: string, force?: boolean) => {
    if (saving) return;
    setError(null);
    setSaving(true);
    try {
      const created = await walkinsApi.create({
        customer_name: name.trim(), customer_phone: phone.trim(),
        alternate_phone: altPhone.trim() || undefined, email: email.trim() || undefined,
        address: address.trim() || undefined, city: city.trim() || undefined,
        state: state.trim() || undefined, pincode: pincode.trim() || undefined,
        source, reference_contact: referenceContact.trim() || undefined,
        architect: architect.trim() || undefined, builder: builder.trim() || undefined,
        salesperson_id: salespersonId, floor_id: floorId,
        interested_products: products.split(",").map((p) => p.trim()).filter(Boolean),
        budget: budget ? Number(budget) : undefined, notes: notes.trim() || undefined,
        use_existing_customer_id: useExistingId, force_new_customer: force,
      });
      toast.success("Walk-in logged");
      router.replace(`/(admin)/walkins/${created.id}` as any);
    } catch (e: any) {
      const conflict = e?.status === 409 ? parseDuplicateConflict(e?.detail) : null;
      if (conflict) {
        setMatches(conflict.matches);
        setDupSheetOpen(true);
      } else {
        const message = typeof e?.detail === "string" ? e.detail : "Could not save the walk-in. Your details are retained; try again.";
        setError(message);
        toast.error(message);
      }
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    if (!name.trim()) { setError("Name is required"); toast.error("Enter the customer's name"); return; }
    if (!phone.trim()) { setError("Phone is required"); toast.error("Enter a phone number"); return; }
    if (!floorId) { setError("Department is required"); toast.error("Select an interested department"); return; }
    if (!salespersonId) { setError("Salesperson is required"); toast.error("Assign a salesperson"); return; }
    setError(null);
    if (matches.medium.length && !resolvedCustomerId && !forceNew) {
      setDupSheetOpen(true);
      return;
    }
    await submit(resolvedCustomerId || undefined, forceNew);
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={isPhone ? [] : ["top"]}>
      <PageHeader title="Log Walk-in" overline="CRM" back={() => router.back()} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView contentContainerStyle={{ padding: isPhone ? spacing.lg : spacing.xl, paddingBottom: isPhone ? 132 : spacing.xxl, gap: spacing.md }} keyboardShouldPersistTaps="handled">
          <Text style={type.overline}>Customer</Text>
          <TextField label="Customer Name *" value={name} onChangeText={setName} placeholder="Full name" testID="walkin-name" />
          <TextField label="Phone *" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="10-digit mobile" testID="walkin-phone" />

          {resolvedHigh ? (
            <Card variant="outlined" style={{ backgroundColor: colors.brandTint, gap: 2 }}>
              <Text style={type.bodySm}>Existing customer found: <Text style={type.bodyStrong}>{resolvedHigh.name}</Text>. This walk-in will be linked to their profile — no duplicate will be created.</Text>
            </Card>
          ) : null}
          {!resolvedHigh && matches.medium.length && !resolvedCustomerId && !forceNew ? (
            <Card variant="outlined" style={{ backgroundColor: colors.warningBg, borderColor: colors.warningBorder, gap: 6 }}>
              <Text style={type.bodySm}>A similar customer may already exist ({matches.medium.length} possible match{matches.medium.length > 1 ? "es" : ""}).</Text>
              <Button label="Review matches" variant="secondary" size="sm" onPress={() => setDupSheetOpen(true)} testID="walkin-review-matches" />
            </Card>
          ) : null}
          {!resolvedHigh && resolvedCustomerId ? (
            <Card variant="outlined" style={{ backgroundColor: colors.brandTint }} testID="walkin-linked-customer-confirmation">
              <Text style={type.bodySm}>Linking to existing customer: <Text style={type.bodyStrong}>{matches.medium.find((m) => m.id === resolvedCustomerId)?.name}</Text></Text>
            </Card>
          ) : null}
          {!resolvedHigh && !matches.medium.length && matches.low.length && !forceNew ? (
            <Text style={type.caption}>Similar name on file: {matches.low.map((m) => m.name).join(", ")} — not blocking, review if unsure.</Text>
          ) : null}

          <TextField label="Alternate Phone" value={altPhone} onChangeText={setAltPhone} keyboardType="phone-pad" placeholder="Optional" testID="walkin-alt-phone" />
          <Disclosure title="Address and additional contact details"><TextField label="Email" value={email} onChangeText={setEmail} keyboardType="email-address" placeholder="Optional" testID="walkin-email" />
          <TextField label="Address" value={address} onChangeText={setAddress} placeholder="Optional" multiline numberOfLines={2} testID="walkin-address" />
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <TextField label="City" value={city} onChangeText={setCity} placeholder="Optional" containerStyle={{ flex: 1 }} testID="walkin-city" />
            <TextField label="State" value={state} onChangeText={setState} placeholder="Optional" containerStyle={{ flex: 1 }} testID="walkin-state" />
          </View>
          <TextField label="Pincode" value={pincode} onChangeText={setPincode} keyboardType="number-pad" placeholder="Optional" testID="walkin-pincode" />

          </Disclosure>
          {optionsError ? <Alert tone="error" title="Some intake options are unavailable" description="Retry to load the configured lead sources and salespeople." action={<Button label="Try again" variant="secondary" onPress={() => setOptionsRetry(value => value + 1)} />} /> : null}
          <Text accessibilityRole="header" style={[type.overline, { marginTop: spacing.sm }]}>Walk-in Details</Text>

          <Text style={type.bodyStrong}>Salesperson *</Text>
          <ListRow
            title={salespersonName || "Select salesperson"}
            subtitle={assignees.find((a) => a.id === salespersonId)?.role}
            leading={<Avatar name={salespersonName} size={36} />}
            right={<Text style={[type.captionStrong, { color: colors.brandHover }]}>Change</Text>}
            onPress={() => setSpSheetOpen(true)}
            isFirst
            testID="walkin-salesperson-row"
          />

          <Text style={type.bodyStrong}>Interested Department *</Text>
          <View style={{ flexDirection: "row", gap: spacing.xs, flexWrap: "wrap" }}>
            {floors.map((f) => (
              <Chip key={f.id} label={f.name} active={floorId === f.id} onPress={() => setFloorId(f.id)} testID={`walkin-floor-${f.id}`} />
            ))}
          </View>

          <Text style={type.bodyStrong}>Lead Source</Text>
          <View style={{ flexDirection: "row", gap: spacing.xs, flexWrap: "wrap" }}>
            {sources.map((s) => (
              <Chip key={s} label={s} active={source === s} onPress={() => setSource(s)} testID={`walkin-source-${s}`} />
            ))}
          </View>

          <Disclosure title="Referral and project details">
          <TextField label="Reference Contact" value={referenceContact} onChangeText={setReferenceContact} placeholder="Who referred this customer?" testID="walkin-reference" />
          <TextField label="Architect" value={architect} onChangeText={setArchitect} placeholder="Project architect" testID="walkin-architect" />
          <TextField label="Builder" value={builder} onChangeText={setBuilder} placeholder="Project builder" testID="walkin-builder" />

          <TextField label="Interested Products" value={products} onChangeText={setProducts} placeholder="Comma-separated, e.g. Vitrified Tiles, Granite" testID="walkin-products" />
          <TextField label="Budget (₹)" value={budget} onChangeText={setBudget} keyboardType="numeric" placeholder="Optional" testID="walkin-budget" />
          <TextField label="Notes" value={notes} onChangeText={setNotes} placeholder="Optional" multiline numberOfLines={3} testID="walkin-notes" /></Disclosure>

        </ScrollView>
        <View style={styles.submitFooter}>
          {error ? <Text accessibilityRole="alert" testID="walkin-submit-error" style={[type.bodySm, { color: colors.error }]}>{error}</Text> : null}
          <Button label="Log Walk-in" onPress={save} loading={saving} fullWidth testID="walkin-save-btn" />
        </View>
      </KeyboardAvoidingView>

      {/* Salesperson picker */}
      <Sheet visible={spSheetOpen} onClose={() => setSpSheetOpen(false)} title="Assign Salesperson" variant="bottom" minHeight="56%" testID="walkin-salesperson-sheet">
        <View style={{ padding: spacing.lg, gap: spacing.md, flex: 1 }}>
          <SearchField placeholder="Search staff…" value={spSearch} onChangeText={setSpSearch} onClear={() => setSpSearch("")} />
          <ScrollView>
            {filteredAssignees.map((a, i) => (
              <ListRow
                key={a.id} title={a.full_name} subtitle={a.role}
                leading={<Avatar name={a.full_name} size={36} />}
                onPress={() => pickSalesperson(a)}
                isFirst={i === 0}
                testID={`walkin-sp-${a.id}`}
              />
            ))}
          </ScrollView>
        </View>
      </Sheet>

      {/* Duplicate resolution — medium-confidence matches require an explicit decision */}
      <Sheet
        visible={dupSheetOpen} onClose={() => setDupSheetOpen(false)}
        title="Possible existing customer" subtitle="A similar customer may already exist. Choose how to proceed."
        variant="bottom" minHeight="48%" testID="walkin-duplicate-sheet"
      >
        <View style={{ padding: spacing.lg, gap: spacing.md, flex: 1 }}>
          <ScrollView>
            {matches.medium.map((m) => (
              <Card key={m.id} variant="outlined" style={{ gap: spacing.xs, marginBottom: spacing.sm }}>
                <Text style={type.bodyStrong}>{m.name}</Text>
                <Text style={type.bodyMuted}>{[m.phone, m.city].filter(Boolean).join(" · ") || "No details on file"}</Text>
                <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap", marginTop: spacing.xs }}>
                  <Button label="Use Existing Customer" size="sm" onPress={() => linkExistingCustomer(m)} testID={`walkin-use-existing-${m.id}`} />
                  <Button
                    label="View Customer" variant="secondary" size="sm"
                    onPress={() => viewExistingCustomer(m.id)}
                    testID={`walkin-view-customer-${m.id}`}
                  />
                </View>
              </Card>
            ))}
          </ScrollView>
          <Button label="Create New Customer Anyway" variant="secondary" onPress={createNewAnyway} testID="walkin-create-new-anyway" />
        </View>
      </Sheet>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  submitFooter: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
});
