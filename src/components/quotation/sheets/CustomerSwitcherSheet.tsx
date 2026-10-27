// Customer switcher — searchable list + inline "create new customer" form.
// Opens from the topbar's Customer field. Switching preserves every line
// item / room / discount already in the builder; only customer_id (and its
// denormalised name snapshot) changes.
import Feather from "@expo/vector-icons/Feather";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { BottomSheet } from "@/src/components/BottomSheet";
import { Button } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";
import { color as ds } from "@/src/design/tokens";
import { api } from "@/src/api/client";

import { useAuth } from "@/src/state/auth";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { hasGrantAccess } from "@/src/team-delegation";

import { useBuilder } from "../context/BuilderContext";

export function CustomerSwitcherSheet() {
  const b = useBuilder();
  const { staff } = useAuth();
  const { floors } = useFloorAccess();
  const canCreateCustomer = useActionAccess("customers", "create", true);
  const canImportGroundCustomer = canCreateCustomer && floors.some((floor) => floor.id === "ground-floor")
    && (!staff?.custom_access || hasGrantAccess(staff.access_grants, "ground-floor", "customers", "view"));
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [project, setProject] = useState("");
  const [address, setAddress] = useState("");
  const [saving, setSaving] = useState(false);
  const [groundSources, setGroundSources] = useState<{ customer: { id: string; name: string; company?: string | null; phone?: string | null }; latest_quotation?: { number?: string; project_name?: string | null } | null }[]>([]);
  const [showGroundSources, setShowGroundSources] = useState(false);
  const [loadingGround, setLoadingGround] = useState(false);

  useEffect(() => {
    if (!showGroundSources || groundSources.length || loadingGround) return;
    setLoadingGround(true);
    api.get<typeof groundSources>("/customers/import-sources/ground-floor")
      .then(setGroundSources).catch(() => setGroundSources([])).finally(() => setLoadingGround(false));
  }, [showGroundSources, groundSources.length, loadingGround]);

  const close = () => {
    b.setCustomerSwitcherOpen(false);
    setCreating(false); setShowGroundSources(false);
    setQ(""); setName(""); setPhone(""); setProject(""); setAddress("");
  };

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return b.customers;
    return b.customers.filter((c) =>
      c.name?.toLowerCase().includes(term)
      || c.company?.toLowerCase().includes(term)
      || c.phone?.toLowerCase().includes(term)
      || c.email?.toLowerCase().includes(term),
    );
  }, [b.customers, q]);

  const pick = (id: string) => {
    b.setCustomer(id);
    close();
  };

  const importGroundCustomer = async (id: string) => {
    if (!canImportGroundCustomer) return;
    const applied = await b.importCustomerFromGround(id);
    if (applied) close();
  };

  const save = async () => {
    if (!name.trim() || !canCreateCustomer) return;
    setSaving(true);
    const id = await b.createCustomer({ name: name.trim(), phone: phone.trim(), address: address.trim() });
    setSaving(false);
    if (id) {
      if (project.trim()) b.setProjectName(project.trim());
      close();
    }
  };

  return (
    <BottomSheet
      visible={b.customerSwitcherOpen}
      onClose={close}
      title={creating ? "New customer" : "Switch customer"}
      testID="customer-switcher-sheet"
      footer={
        creating ? (
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Button label="Cancel" variant="secondary" onPress={() => setCreating(false)} />
            <Button label={saving ? "Saving…" : "Create & select"} onPress={save} disabled={!name.trim() || saving} testID="save-new-customer" />
          </View>
        ) : undefined
      }
    >
      {creating ? (
        <View style={{ gap: spacing.md }}>
          <View style={{ gap: 6 }}>
            <Text style={type.overline}>Name *</Text>
            <TextInput
              testID="new-cust-name"
              value={name}
              onChangeText={setName}
              placeholder="Customer or company name"
              style={styles.input}
              autoFocus
            />
          </View>
          <View style={{ gap: 6 }}>
            <Text style={type.overline}>Phone</Text>
            <TextInput
              testID="new-cust-phone"
              value={phone}
              onChangeText={setPhone}
              placeholder="+91 ·········"
              keyboardType="phone-pad"
              style={styles.input}
            />
          </View>
          <View style={{ gap: 6 }}>
            <Text style={type.overline}>Project</Text>
            <TextInput
              testID="new-cust-project"
              value={project}
              onChangeText={setProject}
              placeholder="Project name (optional)"
              style={styles.input}
            />
          </View>
          <View style={{ gap: 6 }}>
            <Text style={type.overline}>Address</Text>
            <TextInput
              testID="new-cust-address"
              value={address}
              onChangeText={setAddress}
              placeholder="Site / delivery address (optional)"
              style={styles.input}
              multiline
            />
          </View>
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          <View {...(Platform.OS === "web" ? { dataSet: { fieldShell: "true" } } : {})} style={styles.searchWrap}>
            <Feather name="search" size={14} color={colors.onSurfaceMuted} />
            <TextInput
              testID="customer-switcher-search"
              value={q}
              onChangeText={setQ}
              placeholder="Search by name, company, phone…"
              placeholderTextColor={colors.onSurfaceMuted}
              style={styles.searchInput}
              autoFocus
            />
            {q ? (
              <Pressable hitSlop={8} onPress={() => setQ("")}>
                <Feather name="x" size={14} color={colors.onSurfaceMuted} />
              </Pressable>
            ) : null}
          </View>

          {canCreateCustomer ? <Pressable testID="open-create-customer" onPress={() => setCreating(true)} style={styles.createRow}>
            <View style={styles.createIcon}>
              <Feather name="plus" size={14} color={ds.brass} />
            </View>
            <Text style={styles.createLabel}>Create new customer</Text>
          </Pressable> : null}

          {canImportGroundCustomer ? <Pressable testID="open-ground-floor-customers" onPress={() => setShowGroundSources((open) => !open)} style={styles.importRow}>
            <Feather name="copy" size={14} color={ds.brass} />
            <View style={{ flex: 1 }}><Text style={styles.createLabel}>Use Ground Floor customer details</Text><Text style={type.caption}>Copies contact and latest project details, not tile products.</Text></View>
            <Feather name={showGroundSources ? "chevron-up" : "chevron-down"} size={16} color={colors.onSurfaceMuted} />
          </Pressable> : null}

          {showGroundSources ? (
            <View style={styles.groundList}>
              {loadingGround ? <Text style={type.caption}>Loading Ground Floor customers…</Text> : groundSources.length === 0 ? <Text style={type.caption}>No Ground Floor customer profiles available.</Text> : groundSources.map((source) => (
                <Pressable key={source.customer.id} onPress={() => importGroundCustomer(source.customer.id)} style={styles.custRow}>
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text style={styles.custName} numberOfLines={1}>{source.customer.company || source.customer.name}</Text>
                    <Text style={type.caption} numberOfLines={1}>{[source.latest_quotation?.project_name, source.latest_quotation?.number, source.customer.phone].filter(Boolean).join(" · ") || "Contact details"}</Text>
                  </View>
                  <Feather name="arrow-down-left" size={16} color={ds.brass} />
                </Pressable>
              ))}
            </View>
          ) : null}

          {filtered.length === 0 ? (
            <Text style={[type.caption, { padding: 12, textAlign: "center" }]}>No customers match “{q}”.</Text>
          ) : filtered.map((c) => {
            const active = c.id === b.s.customerId;
            return (
              <Pressable
                key={c.id}
                testID={`customer-option-${c.id}`}
                onPress={() => pick(c.id)}
                style={[styles.custRow, active && styles.custRowActive]}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text style={styles.custName} numberOfLines={1}>{c.company || c.name}</Text>
                  <Text style={type.caption} numberOfLines={1}>
                    {[c.name !== (c.company || c.name) ? c.name : null, c.phone, c.email].filter(Boolean).join(" · ") || "—"}
                  </Text>
                </View>
                {active ? <Feather name="check" size={16} color={ds.brass} /> : null}
              </Pressable>
            );
          })}
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    borderRadius: radius.md, paddingHorizontal: 14, paddingVertical: 12, fontSize: 15, color: colors.onSurface,
  },
  searchWrap: {
    flexDirection: "row", alignItems: "center", gap: 8, paddingHorizontal: 12, paddingVertical: 10,
    borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
  },
  searchInput: { flex: 1, fontSize: 14, color: colors.onSurface, padding: 0 },
  createRow: {
    flexDirection: "row", alignItems: "center", gap: 10, padding: 10,
    borderRadius: radius.md, backgroundColor: ds.brassTint,
  },
  createIcon: {
    width: 26, height: 26, borderRadius: 13, backgroundColor: colors.surface,
    alignItems: "center", justifyContent: "center",
  },
  createLabel: { fontSize: 13, fontWeight: "700", color: ds.brass },
  importRow: { flexDirection: "row", alignItems: "center", gap: 10, padding: 10, borderRadius: radius.md, borderWidth: 1, borderColor: ds.brassLine, backgroundColor: colors.surface },
  groundList: { gap: 4, padding: 6, borderRadius: radius.md, backgroundColor: colors.surfaceTertiary },
  custRow: {
    flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 10, paddingHorizontal: 8,
    borderRadius: radius.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.border,
  },
  custRowActive: { backgroundColor: ds.brassTint },
  custName: { fontSize: 13.5, fontWeight: "600", color: colors.onSurface },
});
