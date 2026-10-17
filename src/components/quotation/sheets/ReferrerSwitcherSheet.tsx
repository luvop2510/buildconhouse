import { referrerCode } from "@/src/utils/referrer";
// Referrer switcher — searchable list of architects/interior designers +
// inline "create new" form. Opens from the topbar's "Referred By" field.
import { useMemo, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { Text, TextInput } from "@/src/components/AppText";

import { BottomSheet } from "@/src/components/BottomSheet";
import { Button } from "@/src/components/ui";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

import { useActionAccess } from "@/src/hooks/use-permissions";

import { useBuilder } from "../context/BuilderContext";

type ReferrerType = "architect" | "interior_designer";

export function ReferrerSwitcherSheet() {
  const b = useBuilder();
  const canCreateReferrer = useActionAccess("quotations", "create");
  const [tab, setTab] = useState<ReferrerType>("architect");
  const [q, setQ] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const close = () => {
    b.setReferrerSwitcherOpen(false);
    setCreating(false);
    setQ(""); setName("");
  };

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    const byType = b.referrers.filter((r) => r.type === tab);
    if (!term) return byType;
    return byType.filter((r) => r.name.toLowerCase().includes(term));
  }, [b.referrers, tab, q]);

  const pick = (id: string, refName: string) => {
    b.setReferrer(tab, id, refName);
    close();
  };

  const save = async () => {
    if (!name.trim() || !canCreateReferrer) return;
    setSaving(true);
    const id = await b.createReferrer({ name: name.trim(), type: tab });
    setSaving(false);
    if (id) close();
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
            <Button label="Cancel" variant="secondary" onPress={() => setCreating(false)} />
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
          </View>
        </View>
      ) : (
        <View style={{ gap: spacing.md }}>
          <View style={{ flexDirection: "row", gap: 8 }}>
            <Pressable
              testID="referrer-tab-architect"
              onPress={() => setTab("architect")}
              style={[styles.typeTab, tab === "architect" && styles.typeTabActive]}
            >
              <Text style={[styles.typeTabText, tab === "architect" && styles.typeTabTextActive]}>Architect</Text>
            </Pressable>
            <Pressable
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
          <Pressable onPress={() => b.clearReferrer()} style={styles.row}>
            <Text style={type.body}>None</Text>
          </Pressable>
          {filtered.map((r) => (
            <Pressable key={r.id} testID={`referrer-row-${r.id}`} onPress={() => pick(r.id, r.name)} style={styles.row}>
              <Text style={type.body}>{r.name}</Text><Text style={type.caption}>{referrerCode(r.id, r.type)}{r.customers_acquired == null ? "" : ` · ${r.customers_acquired} customers brought`}</Text>
            </Pressable>
          ))}
          {canCreateReferrer ? <Button label="+ Add new" variant="secondary" onPress={() => setCreating(true)} testID="referrer-add-new" /> : null}
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
