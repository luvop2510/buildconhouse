// Team uses named floor/page/action delegations. Legacy role labels remain
// readable until account migration; new allocations use owner or worker only.
import Feather from "@expo/vector-icons/Feather";
import { useCallback, useEffect, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { AdminPage, IconAction } from "@/src/components/AdminPage";
import { Avatar, Badge, Button, Chip, EmptyState, ErrorState, Sheet, Skeleton, TextField } from "@/src/components/ui";
import { TempPasswordDialog, TempPasswordResult } from "@/src/components/TempPasswordDialog";
import { api } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { useRoles } from "@/src/hooks/use-roles";
import { useAuth } from "@/src/state/auth";
import { useBp } from "@/src/design/responsive";
import { FloorDelegationEditor } from "@/src/components/FloorDelegationEditor";
import { DelegationCatalog, DelegationGrant, DelegationState, isDelegationCatalog, loadDelegation } from "@/src/team-delegation";
import { floorDisplayLabel } from "@/src/constants/floors";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type Staff = {
  id: string; full_name: string; email: string; role: string;
  phone?: string | null; active: boolean; floor_ids?: string[]; custom_access?: boolean; team_role?: string | null;
};
type Floor = { id: string; name: string; slug: string };
export default function Team() {
  const { isPhone } = useBp();
  const { staff: me } = useAuth();
  const { roles } = useRoles();
  const [options, setOptions] = useState<{ floors: Floor[]; catalog: DelegationCatalog } | null>(null);
  const [items, setItems] = useState<Staff[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [optionsError, setOptionsError] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [tempResult, setTempResult] = useState<TempPasswordResult | null>(null);
  const [tempDialogOpen, setTempDialogOpen] = useState(false);

  const load = useCallback(() => {
    setLoadError(false);
    api.get<Staff[]>("/team").then(setItems).catch(() => setLoadError(true));
  }, []);
  useEffect(() => { load(); }, [load]);
  const loadOptions = useCallback(() => {
    setOptionsError(false);
    Promise.all([api.get<Floor[]>("/settings/floors"), api.get<DelegationCatalog>("/settings/access-grants/resources")])
      .then(([floors, catalog]) => {
        if (!isDelegationCatalog(catalog, floors)) throw new Error("Delegation catalog unavailable");
        setOptions({ floors: floors.map((floor) => ({ ...floor, name: floorDisplayLabel(floor) })), catalog });
      })
      .catch(() => setOptionsError(true));
  }, []);
  useEffect(loadOptions, [loadOptions]);

  return (
    <AdminPage
      title="Team"
      subtitle="Choose each person’s floors, pages and actions"
      right={<IconAction icon="user-plus" label="Add" onPress={() => setAddOpen(true)} testID="team-add-btn" />}
    >
      {optionsError ? <ErrorState title="Access options unavailable" subtitle="Retry before assigning staff access." onRetry={loadOptions} /> : null}
      {loadError ? <ErrorState title="Could not load team" onRetry={load} /> : !items ? (
        <View style={{ gap: spacing.sm }}>
          {Array.from({ length: 4 }).map((_, i) => (
            <View key={i} style={[styles.card, { flexDirection: "row", gap: spacing.md }]}>
              <Skeleton w={44} h={44} radius={22} />
              <View style={{ flex: 1, gap: 6 }}>
                <Skeleton w="60%" h={14} />
                <Skeleton w="40%" h={12} />
              </View>
            </View>
          ))}
        </View>
      ) : items.length === 0 ? (
        <EmptyState icon="user-check" title="No team members" subtitle="Only Manager, Admin & Owner roles can access team management." />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((u) => {
            const roleInfo = roles.find((r) => r.role === u.role);
            return (
              <Pressable
                key={u.id}
                testID={`team-row-${u.id}`}
                accessibilityRole="button" accessibilityLabel={`Edit ${u.full_name}`}
                onPress={() => setEditing(u)}
                style={({ pressed }) => [
                  styles.card,
                  {
                    flexDirection: "row", gap: spacing.md, alignItems: "center",
                    flexWrap: isPhone ? "wrap" : "nowrap",
                    opacity: pressed ? 0.85 : 1,
                  },
                ]}
              >
                <Avatar name={u.full_name} size={44} tone="brand" />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{
                    fontSize: 15,
                    fontFamily: type.titleMd.fontFamily,
                    fontWeight: "600",
                    color: colors.onSurface,
                    letterSpacing: -0.1,
                  }}>{u.full_name}{u.id === me?.id ? " · You" : ""}</Text>
                  <Text numberOfLines={1} style={type.caption}>{u.email}</Text>
                </View>
                <View style={{ alignItems: isPhone ? "flex-start" : "flex-end", gap: 4, marginLeft: isPhone ? 44 + spacing.md : 0 }}>
                  <Badge label={u.team_role || (u.custom_access ? "Delegated staff" : roleInfo?.label || u.role)} tone={u.active ? "brand" : "neutral"} size="sm" />
                  {!u.active ? <Badge label="Disabled" tone="warning" size="sm" /> : null}
                </View>
                <Feather name="chevron-right" size={16} color={colors.onSurfaceMuted} />
              </Pressable>
            );
          })}
        </View>
      )}

      <AddStaffSheet visible={addOpen} options={options} optionsError={optionsError} onRetry={loadOptions} onClose={() => setAddOpen(false)} onCreated={load} />
      <EditStaffSheet
        key={editing?.id || "closed"}
        staff={editing}
        options={options}
        optionsError={optionsError}
        onRetry={loadOptions}
        selfId={me?.id}
        onClose={() => setEditing(null)}
        onSaved={() => { load(); setEditing(null); }}
        onPasswordReset={(res) => { setTempResult(res); setTempDialogOpen(true); }}
      />
      <TempPasswordDialog
        visible={tempDialogOpen}
        onClose={() => { setTempDialogOpen(false); setTempResult(null); }}
        title="Password reset"
        result={tempResult}
      />
    </AdminPage>
  );
}

type AccessOptions = { floors: Floor[]; catalog: DelegationCatalog };
const emptyDelegation = (): DelegationState => ({ floorIds: [], grants: [] });

function AccountAccessPicker({ value, onChange, disabled, prefix }: {
  value: string; onChange: (value: string) => void; disabled?: boolean; prefix: string;
}) {
  return <View style={{ gap: 6 }}>
    <Text style={type.label}>Account access</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
      <Chip label="Delegated staff" active={value !== "owner"} onPress={disabled ? undefined : () => onChange("worker")} testID={`${prefix}-role-worker`} />
      <Chip label="Owner" active={value === "owner"} onPress={disabled ? undefined : () => onChange("owner")} testID={`${prefix}-role-owner`} />
    </View>
    <Text style={type.caption}>Owner has full access. Delegated staff use only the floors, pages and actions selected below.</Text>
  </View>;
}

function DelegationOptions({ options, error, onRetry, value, onChange, disabled }: {
  options: AccessOptions | null; error: boolean; onRetry: () => void;
  value: DelegationState; onChange: (value: DelegationState) => void; disabled?: boolean;
}) {
  if (error) return <ErrorState title="Access options unavailable" onRetry={onRetry} />;
  if (!options) return <Text style={type.caption}>Loading floors and pages…</Text>;
  return <FloorDelegationEditor floors={options.floors} catalog={options.catalog} value={value} onChange={onChange} disabled={disabled} />;
}

function AddStaffSheet({ visible, options, optionsError, onRetry, onClose, onCreated }: {
  visible: boolean; options: AccessOptions | null; optionsError: boolean; onRetry: () => void; onClose: () => void; onCreated: () => void;
}) {
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("worker");
  const [teamRole, setTeamRole] = useState("");
  const [delegation, setDelegation] = useState<DelegationState>(emptyDelegation);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => { setFullName(""); setEmail(""); setPhone(""); setPassword(""); setTeamRole(""); setRole("worker"); setDelegation(emptyDelegation()); setError(null); };
  const save = async () => {
    if (!fullName.trim()) { setError("Full name is required"); return; }
    if (!email.trim()) { setError("Email is required"); return; }
    if (password.length < 12) { setError("Initial password must be at least 12 characters"); return; }
    if (!options || optionsError) { setError("Load access options before saving"); return; }
    setSaving(true); setError(null);
    try {
      const owner = role === "owner";
      await api.post("/team", {
        full_name: fullName.trim(), email: email.trim(), phone: phone.trim() || null,
        password, role, team_role: teamRole.trim() || null, access_profile: null,
        custom_access: !owner, floor_ids: owner ? [] : delegation.floorIds,
        ...(!owner ? { access_grants: delegation.grants } : {}),
      });
      toast.success("Team member and access saved — they must set their own password on first sign-in");
      reset(); onCreated(); onClose();
    } catch (cause: any) { setError(cause?.detail || "Could not add team member"); }
    finally { setSaving(false); }
  };
  return <Sheet visible={visible} onClose={() => { if (!saving) { reset(); onClose(); } }} title="Add staff" testID="add-staff-sheet">
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <TextField testID="add-staff-name" label="Full name" value={fullName} onChangeText={setFullName} placeholder="e.g. Priya Sharma" autoFocus />
        <TextField testID="add-staff-email" label="Email" value={email} onChangeText={setEmail} placeholder="name@company.com" autoCapitalize="none" keyboardType="email-address" />
        <TextField testID="add-staff-phone" label="Phone" value={phone} onChangeText={setPhone} placeholder="Optional" keyboardType="phone-pad" />
        <TextField testID="add-staff-password" label="Initial password" value={password} onChangeText={setPassword} placeholder="At least 12 characters" secureTextEntry autoCapitalize="none" helper="They’ll set their own password on first login." />
        <TextField testID="add-staff-team-role" label="Team role name" value={teamRole} onChangeText={setTeamRole} placeholder="e.g. Ground Floor Sales" helper="Give this person a role name that matches their work." maxLength={80} />
        <AccountAccessPicker value={role} onChange={setRole} disabled={saving} prefix="add-staff" />
        {role === "owner" ? <Text style={type.caption}>An owner can access all floors and pages and manage the whole team.</Text> : <DelegationOptions options={options} error={optionsError} onRetry={onRetry} value={delegation} onChange={setDelegation} disabled={saving} />}
        {error ? <Text accessibilityRole="alert" style={[type.caption, { color: colors.error }]}>{error}</Text> : null}
        <Button testID="add-staff-save" label={saving ? "Adding…" : "Add staff member"} variant="primary" size="lg" icon="check" disabled={saving || !options || optionsError} onPress={save} fullWidth />
      </ScrollView>
    </KeyboardAvoidingView>
  </Sheet>;
}

function EditStaffSheet({ staff, options, optionsError, onRetry, selfId, onClose, onSaved, onPasswordReset }: {
  staff: Staff | null; options: AccessOptions | null; optionsError: boolean; onRetry: () => void; selfId?: string;
  onClose: () => void; onSaved: () => void; onPasswordReset: (result: TempPasswordResult) => void;
}) {
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("");
  const [teamRole, setTeamRole] = useState("");
  const [active, setActive] = useState(true);
  const [delegation, setDelegation] = useState<DelegationState>(emptyDelegation);
  const [grantsLoading, setGrantsLoading] = useState(true);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  useEffect(() => {
    if (!staff) return;
    setFullName(staff.full_name); setPhone(staff.phone || ""); setRole(staff.role === "owner" ? "owner" : "worker");
    setTeamRole(staff.team_role || ""); setActive(staff.active); setSaveError(null);
  }, [staff]);
  useEffect(() => {
    let alive = true;
    if (!staff || !options) return;
    setGrantsLoading(true); setGrantsError(null);
    setDelegation(emptyDelegation());
    api.get<{ floor_ids?: string[]; grants: DelegationGrant[] }>(`/settings/access-grants/${staff.id}`).then((response) => {
      if (alive) setDelegation(loadDelegation(response.floor_ids ?? staff.floor_ids ?? [], response.grants, options.catalog.resources));
    }).catch((cause: any) => { if (alive) setGrantsError(cause?.detail || "Could not load this person’s access"); })
      .finally(() => { if (alive) setGrantsLoading(false); });
    return () => { alive = false; };
  }, [staff, options, retryCount]);
  if (!staff) return null;
  const isSelf = staff.id === selfId;
  const save = async () => {
    if (!fullName.trim()) { setSaveError("Full name is required"); return; }
    if (!isSelf && (!options || optionsError || grantsLoading || grantsError)) return;
    setSaving(true); setSaveError(null);
    try {
      const patch: Record<string, unknown> = { full_name: fullName.trim(), phone: phone.trim() || null, team_role: teamRole.trim() || null };
      if (!isSelf) {
        const owner = role === "owner";
        Object.assign(patch, { role, active, access_profile: null, custom_access: !owner, floor_ids: owner ? [] : delegation.floorIds });
        if (!owner) patch.access_grants = delegation.grants;
      }
      await api.patch(`/team/${staff.id}`, patch);
      toast.success("Team member and access saved"); onSaved();
    } catch (cause: any) { setSaveError(cause?.detail || "Could not update team member"); }
    finally { setSaving(false); }
  };
  const resetPassword = async () => {
    setResetting(true);
    try {
      const result = await api.post<TempPasswordResult>(`/team/${staff.id}/reset-password`);
      onClose(); onPasswordReset(result);
    } catch (cause: any) { toast.error(cause?.detail || "Could not reset password"); }
    finally { setResetting(false); }
  };
  return <Sheet visible={!!staff} onClose={() => { if (!saving) onClose(); }} title={staff.full_name} subtitle={staff.email} testID="edit-staff-sheet">
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <TextField testID="edit-staff-name" label="Full name" value={fullName} onChangeText={setFullName} />
        <TextField testID="edit-staff-phone" label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Optional" />
        <TextField testID="edit-staff-team-role" label="Team role name" value={teamRole} onChangeText={setTeamRole} placeholder="e.g. Ground Floor Sales" maxLength={80} />
        <AccountAccessPicker value={role} onChange={setRole} disabled={isSelf || saving} prefix="edit-staff" />
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}><Text style={type.bodyStrong}>Account enabled</Text><Text style={type.caption}>{isSelf ? "You can’t disable your own account." : "Turn off to block sign-in immediately."}</Text></View>
          <Switch testID="edit-staff-active-switch" value={active} onValueChange={setActive} disabled={isSelf || saving} />
        </View>
        {isSelf ? <Text style={type.caption}>You can’t change your own account access.</Text> : role === "owner" ? <Text style={type.caption}>An owner has full access to all floors and pages.</Text> : grantsError ? <ErrorState title="Current access unavailable" subtitle={grantsError} onRetry={() => setRetryCount((count) => count + 1)} /> : grantsLoading ? <Text style={type.caption}>Loading this person’s access…</Text> : <DelegationOptions options={options} error={optionsError} onRetry={onRetry} value={delegation} onChange={setDelegation} disabled={saving} />}
        {saveError ? <Text accessibilityRole="alert" style={[type.caption, { color: colors.error }]}>{saveError}</Text> : null}
        <Button testID="edit-staff-save" label={saving ? "Saving…" : "Save changes"} variant="primary" icon="check" disabled={saving || (!isSelf && (!options || optionsError || grantsLoading || !!grantsError))} onPress={save} fullWidth />
        <View style={styles.divider} />
        <Button testID="edit-staff-reset-password" label={resetting ? "Generating…" : "Reset password"} variant="secondary" icon="key" disabled={resetting || saving || isSelf} onPress={resetPassword} fullWidth />
        <Text style={type.caption}>{isSelf ? "Use Settings > Change password to update your own password." : "Generates a temporary password shown once — share it with them directly."}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  </Sheet>;
}

const styles = StyleSheet.create({
  form: { padding: spacing.xl, gap: spacing.lg },
  card: { backgroundColor: colors.surfaceSecondary, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: spacing.md },
  switchRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider, marginVertical: spacing.xs },
});
