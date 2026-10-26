import { referrerCode } from "@/src/utils/referrer";
// Referrer switcher — searchable list of architects/interior designers +
// inline "create new" form. Opens from the topbar's "Referred By" field.
import { useEffect, useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { BottomSheet } from "@/src/components/BottomSheet";
import { Alert, Button, LoadingState } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

import { useActionAccess } from "@/src/hooks/use-permissions";

import { useBuilder } from "../context/BuilderContext";

type ReferrerType = "architect" | "interior_designer";

export function ReferrerSwitcherSheet() {
  const b = useBuilder();
  const canCreateReferrer = useActionAccess("quotations", "create");
  const [tab, setTab] = useState<ReferrerType | "all">("all");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [company, setCompany] = useState("");
  const [visibleCount, setVisibleCount] = useState(25);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { setVisibleCount(25); }, [tab, q]);
  useEffect(() => { if (b.referrerSwitcherOpen) { setTab("all"); setQ(""); } }, [b.referrerSwitcherOpen]);
  const close = () => {
    if (saving) return;
    b.setReferrerSwitcherOpen(false);
    setCreating(false);
    setQ(""); setName(""); setCompany("");
  };

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const byType = b.referrers.filter((r) => tab === "all" || r.type === tab);
    if (!term) return byType;
    return byType.filter((r) => [r.name, r.company, referrerCode(r.id, r.type)].some(value => value?.toLowerCase().includes(term)));
  }, [b.referrers, tab, q]);

  const pick = (id: string, refName: string, kind: ReferrerType) => {
    b.setReferrer(kind, id, refName);
    close();
  };

  const save = async () => {
    if (!name.trim() || !canCreateReferrer || saving || tab === "all") return;
    setSaving(true);
    const id = await b.createReferrer({ name: name.trim(), type: tab, company: company.trim() || undefined });
    setSaving(false);
    if (id) { b.setReferrerSwitcherOpen(false); setCreating(false); setName(""); setCompany(""); }
  };

  return (
    <BottomSheet
      visible={b.referrerSwitcherOpen}
      onClose={close}
      title={creating ? "New referrer" : "Referred by"}
      testID="referrer-switcher-sheet"
      footer={
        creating ? (
          <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
            <Button label="Cancel" variant="secondary" disabled={saving} onPress={() => setCreating(false)} />
            <Button label={saving ? "Saving…" : "Create & select"} onPress={save} disabled={!name.trim() || saving} testID="save-new-referrer" />
          </View>
        ) : undefined
      }
    >
      {creating ? (
        <View style={{ gap: spacing.md }}>
          <View style={{ gap: 6 }}>
            <Text style={type.overline}>Name *</Text>
            <TextInput
              testID="new-referrer-name"
              value={name}
              onChangeText={setName}
              placeholder={tab === "architect" ? "Architect or firm name" : "Interior designer or studio name"}
              style={styles.input}
              autoFocus
            />
            <TextInput accessibilityLabel="Interior / studio name" value={company} onChangeText={setCompany} placeholder="Company / studio (optional)" style={styles.input} />
          </View>
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          <Text accessibilityRole="header" style={type.titleSm}>Choose an existing reference</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable accessibilityRole="button" onPress={() => setTab("all")} style={[styles.typeTab, tab === "all" && styles.typeTabActive]}><Text style={styles.typeTabText}>All references</Text></Pressable>
            <Pressable
              accessibilityRole="button"
              testID="referrer-tab-architect"
              onPress={() => setTab("architect")}
              style={[styles.typeTab, tab === "architect" && styles.typeTabActive]}
            >
              <Text style={[styles.typeTabText, tab === "architect" && styles.typeTabTextActive]}>Architect</Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              testID="referrer-tab-interior_designer"
              onPress={() => setTab("interior_designer")}
              style={[styles.typeTab, tab === "interior_designer" && styles.typeTabActive]}
            >
              <Text style={[styles.typeTabText, tab === "interior_designer" && styles.typeTabTextActive]}>Interior Designer</Text>
            </Pressable>
          </View>
          <TextInput
            testID="referrer-search"
            value={q}
            onChangeText={setQ}
            placeholder="Search…"
            style={styles.input}
          />
          {b.referrersLoading ? <LoadingState label="Loading references…" /> : null}
          {b.referrersError ? <><Alert tone="error" title={b.referrersError} /><Button label="Retry references" variant="secondary" onPress={b.retryReferrers} /></> : null}
          {!b.referrersLoading && !b.referrersError && !filtered.length ? <Text style={type.body}>No matching references.</Text> : null}
          <Pressable accessibilityRole="button" onPress={() => { b.clearReferrer(); close(); }} style={styles.row}>
            <Text style={type.body}>None</Text>
          </Pressable>
          {filtered.slice(0, visibleCount).map((r) => (
            <Pressable key={r.id} testID={`referrer-row-${r.id}`} accessibilityRole="button" onPress={() => pick(r.id, r.name, r.type)} style={styles.row}>
              <Text style={type.body}>{[r.name, r.company].filter(Boolean).join(" · ")}</Text><Text style={type.caption}>{referrerCode(r.id, r.type)}{r.customers_acquired == null ? "" : ` · ${r.customers_acquired} customers brought`}</Text>
            </Pressable>
          ))}
          {filtered.length > visibleCount ? <Button label="Show more references" variant="secondary" onPress={() => setVisibleCount(count => count + 25)} /> : null}
          {canCreateReferrer && tab === "all" ? <Text style={type.caption}>Choose Architect or Interior Designer to add a new contact.</Text> : null}
          {canCreateReferrer && tab !== "all" ? <Button label="+ Add new" variant="secondary" onPress={() => setCreating(true)} testID="referrer-add-new" /> : null}
        </View>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  input: {
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, borderRadius: radius.md,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, fontSize: 15,
  },
  row: { paddingVertical: spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  typeTab: {
    flex: 1, paddingVertical: spacing.sm, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, alignItems: "center",
  },
  typeTabActive: { backgroundColor: colors.brandTint, borderColor: colors.brand },
  typeTabText: { fontSize: 13, fontWeight: "500", color: colors.onSurfaceMuted },
  typeTabTextActive: { color: colors.brand, fontWeight: "600" },
});
