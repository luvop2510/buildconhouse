import { formatPhone } from "@/src/utils/phone";
import { LeadScopeFields } from "@/src/components/leads/LeadScopeFields";
import type { LeadScope } from "@/src/api/leads";
import { Disclosure } from "@/src/design/Disclosure";
// Keep intake short; existing customer matching and explicit floor assignments remain shared.
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
import { hasGrantAccess } from "@/src/team-delegation";
import { useAuth } from "@/src/state/auth";
import { colors, spacing, type } from "@/src/theme/tokens";

type Assignee = { id: string; full_name: string; role: string };

export default function NewWalkIn() {
  const router = useRouter();
  const { isPhone } = useBp();
  const { floor_id: routeFloorId } = useLocalSearchParams<{ floor_id?: string }>();
  const { staff } = useAuth();
  const { floors: assignedFloors, selectedFloorId } = useFloorAccess();
  const floors = staff?.custom_access ? assignedFloors.filter(floor => hasGrantAccess(staff.access_grants, floor.id, "walkins", "create")) : assignedFloors;
  const [optionsError, setOptionsError] = useState(false);
  const [optionsRetry, setOptionsRetry] = useState(0);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");

  const [source, setSource] = useState("Walk-in");
  const [sources, setSources] = useState<string[]>(["Walk-in", "Reference", "Architect", "Builder", "Social Media", "Existing Customer", "Other"]);
  const [floorId, setFloorId] = useState(routeFloorId || selectedFloorId || floors[0]?.id || "");
  const [scope, setScope] = useState<LeadScope>({ interested_floor_ids: [routeFloorId || selectedFloorId || floors[0]?.id || ""].filter(Boolean), assignments: [] });
  const [error, setError] = useState<string | null>(null);

  // Catalog floors use the selected floor team as their assignment source.
  const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [salespersonId, setSalespersonId] = useState<string>(staff?.role !== "owner" || !["first-floor", "ground-floor", "third-floor"].includes(floorId) ? staff?.id || "" : "");
  const [salespersonName, setSalespersonName] = useState<string>(staff?.role !== "owner" || !["first-floor", "ground-floor", "third-floor"].includes(floorId) ? staff?.full_name || "" : "");
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

  }, [optionsRetry]);

  useEffect(() => {
    if (!floorId) return;
    let active = true;
    setAssignees([]);
    walkinsApi.listAssignees({ floorId }).then(rows => {
      if (!active) return;
      setAssignees(rows);
      setSalespersonId(current => rows.some(row => row.id === current) ? current : "");
    }).catch(() => { if (active) setOptionsError(true); });
    return () => { active = false; };
  }, [floorId, optionsRetry]);

  useEffect(() => {
    if (salespersonId) return;
    if ((staff?.role !== "owner" || !["first-floor", "ground-floor", "third-floor"].includes(floorId)) && staff?.id && assignees.some(row => row.id === staff.id)) { setSalespersonId(staff.id); setSalespersonName(staff.full_name); }
    else setSalespersonName("");
  }, [staff, salespersonId, assignees, floorId]);

  useEffect(() => {
    if (routeFloorId) { setFloorId(routeFloorId); return; }
    if (!floorId && (selectedFloorId || floors[0]?.id)) setFloorId(selectedFloorId || floors[0]?.id);
  }, [routeFloorId, selectedFloorId, floors, floorId]);
  useEffect(() => {
    if (!floorId || !floors.some(floor => floor.id === floorId)) return;
    setScope(current => current.interested_floor_ids.length ? current : { ...current, interested_floor_ids: [floorId] });
  }, [floorId, floors]);

  useEffect(() => {
    const digits = phone.replace(/\D/g, "");
    const hasSignal = digits.length >= 10 || name.trim().length >= 3;
    setResolvedCustomerId(null);
    setForceNew(false);
    if (!hasSignal) { setMatches({ high: [], medium: [], low: [] }); return; }
    let active = true;
    const t = setTimeout(() => {
      walkinsApi.checkDuplicate({ phone, name, address, floorId })
        .then((r) => {
          if (active) setMatches(r);
        })
        .catch(() => {});
    }, 450);
    return () => { active = false; clearTimeout(t); };
  }, [phone, name, address, floorId]);

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
        address: address.trim(), source,
        salesperson_id: ["first-floor", "ground-floor", "third-floor"].includes(floorId) ? scope.assignments.find(a => a.floor_id === floorId)?.user_id : salespersonId, floor_id: floorId,
        ...scope,
        use_existing_customer_id: useExistingId, force_new_customer: force,
      });
      toast.success("Walk-in logged");
      router.replace(`/(admin)/walkins/${created.id}?floor_id=${created.floor_id}` as any);
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
    if (!address.trim()) { setError("Address is required"); toast.error("Enter the customer's address"); return; }
    if (!scope.interested_floor_ids.length) { setError("Select at least one interested floor"); return; }
    if (!floorId) { setError("Department is required"); toast.error("Select an interested department"); return; }
    if (["first-floor", "ground-floor", "third-floor"].includes(floorId) ? !scope.assignments.some(a => a.floor_id === floorId) : !salespersonId) { setError("Salesperson is required"); toast.error("Assign a salesperson for this floor"); return; }
    setError(null);
    if (matches.medium.length && !resolvedCustomerId && !forceNew) {
      setDupSheetOpen(true);
      return;
    }
    await submit(resolvedCustomerId || undefined, forceNew);
  };

  return (
    <SafeAreaView style={{ flex: 1 }} edges={isPhone ? [] : ["top"]}>
      <KeyboardAvoidingView enabled={Platform.OS !== "web"} style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
        <ScrollView style={styles.scroll} contentContainerStyle={[styles.form, { padding: isPhone ? spacing.lg : spacing.xl }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <PageHeader title="Log Walk-in" back={() => router.back()} embedded />
          <Text accessibilityRole="header" style={type.bodyStrong}>Customer details</Text>
          <TextField label="Customer name *" error={error === "Name is required" ? error : undefined} autoComplete="name" value={name} onChangeText={setName} placeholder="Full name" testID="walkin-name" />
          <TextField label="Phone *" error={error === "Phone is required" ? error : undefined} autoComplete="tel" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="10-digit mobile" testID="walkin-phone" />

          <TextField label="Address *" error={error === "Address is required" ? error : undefined} value={address} onChangeText={setAddress} placeholder="Street, area and city" autoComplete="street-address" multiline numberOfLines={2} testID="walkin-address" />

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

          {optionsError ? <Alert tone="error" title="Some intake options are unavailable" description="Retry to load the configured lead sources and salespeople." action={<Button label="Try again" variant="secondary" onPress={() => setOptionsRetry(value => value + 1)} />} /> : null}
          <Text accessibilityRole="header" style={[type.overline, { marginTop: spacing.sm }]}>Visit details</Text>

          {!["first-floor", "ground-floor", "third-floor"].includes(floorId) ? <><Text style={type.bodyStrong}>Salesperson *</Text>
          <ListRow
            title={salespersonName || "Select salesperson"}
            subtitle={assignees.find((a) => a.id === salespersonId)?.role}
            leading={<Avatar name={salespersonName} size={36} />}
            right={<Text style={[type.captionStrong, { color: colors.brandHover }]}>Change</Text>}
            onPress={() => setSpSheetOpen(true)}
            isFirst
            testID="walkin-salesperson-row"
          /></> : null}

          <LeadScopeFields assignmentsRequired={["first-floor", "ground-floor", "third-floor"].includes(floorId)} customerPhone={phone} sourceFloorId={floorId} value={scope} onChange={value => { setScope(value); if (value.interested_floor_ids.length && !value.interested_floor_ids.includes(floorId)) setFloorId(value.interested_floor_ids[0]); }} reference={false} />

          <Disclosure title="Lead source" summary={source}>
          <View style={{ flexDirection: "row", gap: spacing.sm, flexWrap: "wrap" }}>
            {sources.map((s) => (
              <Chip key={s} label={s} active={source === s} onPress={() => setSource(s)} testID={`walkin-source-${s}`} />
            ))}
          </View>
          </Disclosure>
        </ScrollView>
        <View style={styles.submitFooter}>
          {error ? <Text accessibilityRole="alert" testID="walkin-submit-error" style={[type.bodySm, { color: colors.error }]}>{error}</Text> : null}
          <Button label="Log Walk-in" onPress={save} loading={saving} testID="walkin-save-btn" />
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
                <Text style={type.bodyMuted}>{[formatPhone(m.phone), m.city].filter(Boolean).join(" · ") || "No details on file"}</Text>
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
  scroll: { flex: 1, minHeight: 0 },
  form: { width: "100%", maxWidth: 720, alignSelf: "center", gap: spacing.md, paddingBottom: spacing.xl },
  submitFooter: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
  },
});
