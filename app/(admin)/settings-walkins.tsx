import { Feather } from "@expo/vector-icons";
import { useRouter } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { ScrollView, Text, TouchableOpacity, View } from "react-native";

import { walkinsApi } from "@/src/api/walkins";
import { toast } from "@/src/components/Toast";
import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { Button, Card, TextField, ErrorState } from "@/src/components/ui";
import { useAuth } from "@/src/state/auth";
import { colors, spacing, type } from "@/src/theme/tokens";

const MANAGER_ROLES = ["owner", "admin", "manager"];

export default function WalkInSettings() {
  const router = useRouter();
  const { staff } = useAuth();
  const [sources, setSources] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [savedSources, setSavedSources] = useState<string[]>([]);
  const dirty = JSON.stringify(sources) !== JSON.stringify(savedSources);
  const canManage = MANAGER_ROLES.includes(staff?.role || "");

  const load = useCallback(() => {
    setLoading(true); setLoadError(false);
    walkinsApi.listSources().then(value => { setSources(value.sources); setSavedSources(value.sources); }).catch(() => setLoadError(true)).finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const addSource = () => {
    const value = draft.trim();
    if (!value) return;
    if (sources.some((source) => source.toLowerCase() === value.toLowerCase())) {
      toast.error("That lead source already exists");
      return;
    }
    setSources((current) => [...current, value]);
    setDraft("");
  };

  const save = async () => {
    if (saving || loading || loadError || !canManage || !dirty) return;
    setSaving(true);
    try {
      const saved = await walkinsApi.updateSources(sources);
      setSources(saved.sources);
      setSavedSources(saved.sources);
      toast.success("Lead sources saved");
    } catch (error: any) {
      toast.error(error?.detail || "Could not save lead sources");
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminPage title="Walk-in setup" subtitle="Lead sources shown when your team logs a walk-in" back={() => router.back()} scroll={false}>
      <ScrollView style={{ flex: 1 }} contentContainerStyle={{ gap: spacing.lg, paddingBottom: spacing.xxxl }} keyboardShouldPersistTaps="handled">
        <Card style={{ gap: spacing.md }} testID="walkin-sources-settings-card">
          <View style={{ gap: 4 }}>
            <Text style={type.overline}>Lead sources</Text>
            <Text style={type.caption}>These are separate from a project’s reference contact, architect, and builder.</Text>
          </View>
          {!canManage ? (
            <Text testID="walkin-sources-permission-message" style={[type.bodyMuted, { color: colors.warning }]}>Only managers can change lead sources.</Text>
          ) : null}
          <View style={{ gap: spacing.sm }}>
            {loadError ? <ErrorState title="Could not load lead sources" subtitle="Retry before changing the source list." onRetry={load} /> : loading ? <Text testID="walkin-sources-loading" style={type.bodyMuted}>Loading lead sources…</Text> : sources.map((source) => (
              <View key={source} testID={`walkin-source-row-${source}`} style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.divider }}>
                <Text style={[type.bodyStrong, { flex: 1 }]}>{source}</Text>
                {canManage ? <TouchableOpacity testID={`walkin-source-remove-${source}`} accessibilityRole="button" accessibilityLabel={`Remove ${source}`} onPress={() => setSources((current) => current.filter((item) => item !== source))} style={{ minWidth: 44, minHeight: 44, alignItems: "center", justifyContent: "center" }}>
                  <Feather name="x" size={18} color={colors.error} />
                </TouchableOpacity> : null}
              </View>
            ))}
          </View>
          {canManage && !loading && !loadError ? <>
            <TextField label="Add lead source" value={draft} onChangeText={setDraft} placeholder="e.g. Trade fair" testID="walkin-source-draft" />
            <Button label="Add source" variant="secondary" onPress={addSource} disabled={!draft.trim() || saving} testID="walkin-source-add" />
            <Button label="Save lead sources" onPress={save} loading={saving} disabled={!dirty || saving} testID="walkin-sources-save" />
          </> : null}
        </Card>
      </ScrollView>
    </AdminPage>
  );
}