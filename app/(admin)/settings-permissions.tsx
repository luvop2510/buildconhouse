// Settings > Team > Permissions — configurable per-role module visibility.
//
// The role hierarchy itself (auth.ROLE_HIERARCHY) stays fixed and is still
// the only thing that actually authorizes data access on the backend — this
// screen edits an ADDITIVE visibility matrix (GET/PUT
// /api/settings/permission-matrix) that controls which modules render in
// each role's navigation. Owner-only edit; every other role sees the same
// matrix read-only so they understand what their own role can see.
import Feather from "@expo/vector-icons/Feather";
import { useRouter } from "expo-router";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Switch, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { Button, Card, EmptyState, ErrorState } from "@/src/components/ui";
import { toast } from "@/src/components/Toast";
import { api } from "@/src/api/client";
import { usePermissionMatrix } from "@/src/hooks/use-permissions";
import { useAuth } from "@/src/state/auth";
import { colors, spacing, type } from "@/src/theme/tokens";

export default function SettingsPermissions() {
  const router = useRouter();
  const { staff } = useAuth();
  const { data, loading, refresh } = usePermissionMatrix();
  const isOwner = staff?.role === "owner";

  const [draft, setDraft] = useState<Record<string, Record<string, boolean>> | null>(null);
  const [activeRole, setActiveRole] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data && !draft) {
      setDraft(JSON.parse(JSON.stringify(data.matrix)));
      setActiveRole((cur) => cur || data.roles[0]?.role || null);
    }
  }, [data, draft]);

  const dirty = useMemo(() => {
    if (!data || !draft) return false;
    return JSON.stringify(data.matrix) !== JSON.stringify(draft);
  }, [data, draft]);

  const toggle = (role: string, moduleKey: string) => {
    if (!isOwner || saving) return;
    setDraft((cur) => {
      if (!cur) return cur;
      const row = { ...(cur[role] || {}) };
      row[moduleKey] = !row[moduleKey];
      return { ...cur, [role]: row };
    });
  };

  const save = async () => {
    if (!draft || saving || !isOwner || !dirty) return;
    setSaving(true);
    try {
      await api.put("/settings/permission-matrix", { overrides: draft });
      await refresh();
      toast.success("Permissions updated");
    } catch (e: any) {
      toast.error(e?.detail || "Could not save — Owner must keep Settings and Team visible");
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (data) setDraft(JSON.parse(JSON.stringify(data.matrix)));
  };

  return (
    <AdminPage
      title="Roles & permissions"
      subtitle={isOwner ? "Configure which modules each role can see" : "What your role can see — owner-configurable"}
      back={() => router.back()}
      scroll={false}
    >
      {loading && !data ? (
        <ActivityIndicator color={colors.onSurfaceMuted} />
      ) : !data || !draft ? <ErrorState title="Could not load permissions" onRetry={refresh} /> : !data.modules.length || !data.roles.length ? <EmptyState icon="shield" title="No permission modules available" subtitle="The permission service returned no configurable modules or roles." /> : (
        <View style={{ flex: 1, gap: spacing.md }}>
          <ScrollView
            horizontal showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: 8, paddingBottom: 4 }}
          >
            {data.roles.map((r) => (
              <RolePill
                key={r.role}
                label={r.label}
                active={activeRole === r.role}
                onPress={() => setActiveRole(r.role)}
                testID={`perm-role-${r.role}`}
              />
            ))}
          </ScrollView>

          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={{ gap: spacing.md, paddingBottom: spacing.xxxl }}>
            {!isOwner ? (
              <View style={styles.readOnlyHint}>
                <Feather name="lock" size={13} color={colors.onSurfaceMuted} />
                <Text style={styles.readOnlyHintText}>Only the Owner can change this matrix.</Text>
              </View>
            ) : null}
            <Card padding={0}>
              {data.modules.map((m, i) => {
                const allowed = !!(activeRole && draft[activeRole]?.[m.key]);
                const isLockedRow = activeRole === "owner" && (m.key === "settings" || m.key === "team");
                return (
                  <View
                    key={m.key}
                    style={[
                      styles.moduleRow,
                      i > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.divider },
                    ]}
                  >
                    <View style={{ flex: 1, minWidth: 0 }}>
                      <Text style={type.bodyStrong} numberOfLines={1}>{m.label}</Text>
                      {isLockedRow ? (
                        <Text style={type.caption}>Always visible to Owner</Text>
                      ) : null}
                    </View>
                    <Switch
                      testID={`perm-switch-${activeRole}-${m.key}`}
                      value={allowed}
                      disabled={!isOwner || isLockedRow || saving}
                      onValueChange={() => { if (activeRole) toggle(activeRole, m.key); }}
                      trackColor={{ false: colors.border, true: colors.brand }}
                      thumbColor="#fff"
                    />
                  </View>
                );
              })}
            </Card>
            {data.updated_at ? (
              <Text style={type.caption}>
                Last changed {new Date(data.updated_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                {data.updated_by_name ? ` by ${data.updated_by_name}` : ""}
              </Text>
            ) : null}
          </ScrollView>

          {isOwner && dirty ? (
            <View style={styles.saveBar}>
              <View style={{ flex: 1 }}>
                <Button label="Discard" variant="secondary" onPress={discard} fullWidth disabled={saving} />
              </View>
              <View style={{ flex: 1 }}>
                <Button label="Save changes" onPress={save} fullWidth loading={saving} testID="perm-save" />
              </View>
            </View>
          ) : null}
        </View>
      )}
    </AdminPage>
  );
}

function RolePill({ label, active, onPress, testID }: { label: string; active: boolean; onPress: () => void; testID?: string }) {
  return (
    <Text
      onPress={onPress}
      testID={testID}
      style={[styles.rolePill, active && styles.rolePillActive]}
      suppressHighlighting
    >
      {label}
    </Text>
  );
}

const styles = StyleSheet.create({
  rolePill: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 999,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surfaceSecondary,
    fontSize: 12.5, fontWeight: "600", color: colors.onSurface, overflow: "hidden",
  },
  rolePillActive: { backgroundColor: colors.brand, borderColor: colors.brand, color: colors.onBrand },
  moduleRow: {
    flexDirection: "row", alignItems: "center", gap: spacing.md,
    paddingHorizontal: spacing.lg, paddingVertical: spacing.md,
  },
  readOnlyHint: {
    flexDirection: "row", alignItems: "center", gap: 6,
    paddingHorizontal: 4,
  },
  readOnlyHintText: { fontSize: 12, color: colors.onSurfaceMuted },
  saveBar: {
    flexDirection: "row", gap: spacing.sm,
    paddingHorizontal: spacing.xl, paddingVertical: spacing.md,
    borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
});
