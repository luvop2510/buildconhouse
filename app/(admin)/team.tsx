import { hasMinimumPasswordLength } from "@/src/utils/passwordPolicy";
// Team uses named floor/page/action delegations. Legacy role labels remain
// readable until account migration; new allocations use owner or worker only.
import Feather from "@expo/vector-icons/Feather";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, View } from "react-native";
import { Text } from "@/src/components/AppText";

import { ConfirmDialog } from "@/src/components/ds";
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
import { optionalContact, teamErrorMessage, validateTeamContacts } from "@/src/team-contacts";
import { floorDisplayLabel } from "@/src/constants/floors";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type Staff = {
  id: string; full_name: string; email?: string | null; role: string;
  phone?: string | null; mobile?: string | null; login_id?: string | null; active: boolean; floor_ids?: string[]; custom_access?: boolean; team_role?: string | null;
};
type Floor = { id: string; name: string; slug: string };
export default function Team() {
  const { isPhone } = useBp();
  const { staff: me } = useAuth();
  const { roles } = useRoles();
  const isOwner = me?.role === "owner";
  const ownerId = isOwner ? me.id : null;
  const [options, setOptions] = useState<{ floors: Floor[]; catalog: DelegationCatalog } | null>(null);
  const [items, setItems] = useState<Staff[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [optionsError, setOptionsError] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [tempResult, setTempResult] = useState<TempPasswordResult | null>(null);
  const [tempDialogOpen, setTempDialogOpen] = useState(false);

  const loadVersion = useRef(0);
  const optionsVersion = useRef(0);
  const load = useCallback(() => {
    if (!ownerId) return;
    setLoadError(false);
    const version = ++loadVersion.current;
    api.get<Staff[]>("/team").then((result) => {
      if (version !== loadVersion.current) return;
      setItems(result);
    }).catch(() => { if (version === loadVersion.current) setLoadError(true); });
  }, [ownerId]);
  useEffect(() => { const requests = loadVersion; setItems(null); load(); return () => { requests.current++; }; }, [load]);
  const loadOptions = useCallback(() => {
    if (!ownerId) return;
    setOptionsError(false);
    const version = ++optionsVersion.current;
    Promise.all([api.get<Floor[]>("/settings/floors"), api.get<DelegationCatalog>("/settings/access-grants/resources")])
      .then(([floors, catalog]) => {
        if (version !== optionsVersion.current) return;
        if (!isDelegationCatalog(catalog, floors)) throw new Error("Delegation catalog unavailable");
        setOptions({ floors: floors.map((floor) => ({ ...floor, name: floorDisplayLabel(floor) })), catalog });
      })
      .catch(() => { if (version === optionsVersion.current) setOptionsError(true); });
  }, [ownerId]);
  useEffect(() => { const requests = optionsVersion; setOptions(null); loadOptions(); return () => { requests.current++; }; }, [loadOptions]);

  if (!isOwner) return <AdminPage title="Team"><CardNotice /></AdminPage>;

  return (
    <AdminPage
      title="Team"
      subtitle="Choose each person’s floors, pages and actions"
      right={<IconAction icon="user-plus" label="Add" onPress={() => setAddOpen(true)} testID="team-add-btn" />}
    >
      {optionsError ? <ErrorState title="Access options unavailable" subtitle="Retry before assigning staff access." onRetry={loadOptions} /> : null}
      {loadError ? <ErrorState title="Could not load team" subtitle={items ? "Your last loaded team is shown below. Retry to refresh it." : undefined} onRetry={load} /> : null}
      {!items ? loadError ? null : (
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
        <EmptyState icon="user-check" title="No team members" subtitle="Create a member and choose the floors and actions they can use." />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {items.map((u) => {
            const roleInfo = roles.find((r) => r.role === u.role);
            const phone = optionalContact(u.phone), mobile = optionalContact(u.mobile);
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
                  {optionalContact(u.email) ? <Text testID={`team-email-${u.id}`} numberOfLines={1} style={type.caption}>{u.email}</Text> : null}
                  {optionalContact(u.login_id) ? <Text testID={`team-username-${u.id}`} numberOfLines={1} style={type.caption}>ID: {u.login_id}</Text> : null}
                  {phone || mobile ? <Text testID={`team-phone-${u.id}`} numberOfLines={1} style={type.caption}>{[phone ? `Phone: ${phone}` : null, mobile ? `Mobile: ${mobile}` : null].filter(Boolean).join(" · ")}</Text> : null}
                </View>
                <Feather name="chevron-right" size={16} color={colors.onSurfaceMuted} />
                <View style={{ alignItems: isPhone ? "flex-start" : "flex-end", gap: 4, minWidth: 0, flexShrink: 1, ...(isPhone ? { width: "100%", paddingLeft: 44 + spacing.md } : { maxWidth: "40%" }) }}>
                  <Badge label={u.team_role || (u.custom_access ? "Delegated staff" : roleInfo?.label || u.role)} tone={u.active ? "brand" : "neutral"} size="sm" truncate testID={`team-role-${u.id}`} />
                  {!u.active ? <Badge label="Disabled" tone="warning" size="sm" /> : null}
                </View>
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
        permanent
      />
    </AdminPage>
  );
}

function CardNotice() {
  return <View testID="team-owner-only" style={styles.card}><Text style={type.body}>Only the owner can create, delete or manage team members and passwords.</Text></View>;
}

type AccessOptions = { floors: Floor[]; catalog: DelegationCatalog };
const emptyDelegation = (): DelegationState => ({ floorIds: [], grants: [] });

function ContactFields({ prefix, email, onEmail, phone, onPhone, mobile, onMobile, disabled }: {
  prefix: string; email: string; onEmail: (value: string) => void; phone: string; onPhone: (value: string) => void;
  mobile: string; onMobile: (value: string) => void; disabled: boolean;
}) {
  return <View style={{ gap: spacing.md }}>
    <Text style={type.label}>Contact details</Text>
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.md }}>
      <View style={styles.contactColumn}><TextField testID={`${prefix}-phone`} label="Phone" value={phone} onChangeText={onPhone} keyboardType="phone-pad" placeholder="Optional" maxLength={40} editable={!disabled} /></View>
      <View style={styles.contactColumn}><TextField testID={`${prefix}-mobile`} label="Mobile" value={mobile} onChangeText={onMobile} keyboardType="phone-pad" placeholder="Optional" maxLength={40} editable={!disabled} /></View>
      <View style={styles.contactColumn}><TextField testID={`${prefix}-email`} label="Email" value={email} onChangeText={onEmail} keyboardType="email-address" placeholder="Optional email address" autoCapitalize="none" autoCorrect={false} maxLength={254} editable={!disabled} /></View>
    </View>
    <Text style={type.caption}>Contacts are optional. Keep an email or username for sign-in.</Text>
  </View>;
}

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
  const [username, setUsername] = useState("");
  const [phone, setPhone] = useState("");
  const [mobile, setMobile] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("worker");
  const [teamRole, setTeamRole] = useState("");
  const [delegation, setDelegation] = useState<DelegationState>(emptyDelegation);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reset = () => { setFullName(""); setEmail(""); setUsername(""); setPhone(""); setMobile(""); setPassword(""); setTeamRole(""); setRole("worker"); setDelegation(emptyDelegation()); setError(null); };
  const save = async () => {
    if (saving) return;
    if (!fullName.trim()) { setError("Full name is required"); return; }
    const contactError = validateTeamContacts(email, username, phone, mobile);
    if (contactError) { setError(contactError); return; }
    if (!hasMinimumPasswordLength(password)) { setError("Initial password must be at least 6 characters"); return; }
    if (!options || optionsError) { setError("Load access options before saving"); return; }
    setSaving(true); setError(null);
    try {
      const owner = role === "owner";
      await api.post("/team", {
        full_name: fullName.trim(), email: optionalContact(email)?.toLowerCase() || null, login_id: optionalContact(username), phone: optionalContact(phone), mobile: optionalContact(mobile),
        password, role, team_role: teamRole.trim() || null, access_profile: null,
        custom_access: !owner, floor_ids: owner ? [] : delegation.floorIds,
        ...(!owner ? { access_grants: delegation.grants } : {}),
      });
      toast.success("Team member and access saved — their password is managed by the owner");
      reset(); onCreated(); onClose();
    } catch (cause: unknown) { setError(teamErrorMessage(cause, "Could not add team member")); }
    finally { setSaving(false); }
  };
  return <Sheet visible={visible} width={720} onClose={() => { if (!saving) { reset(); onClose(); } }} title="Add staff" testID="add-staff-sheet">
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <TextField testID="add-staff-name" label="Full name" value={fullName} onChangeText={setFullName} placeholder="e.g. Priya Sharma" autoFocus />
        <TextField testID="add-staff-username" label="Username" value={username} onChangeText={setUsername} placeholder="Optional sign-in username" autoCapitalize="none" autoCorrect={false} maxLength={120} />
        <ContactFields prefix="add-staff" email={email} onEmail={setEmail} phone={phone} onPhone={setPhone} mobile={mobile} onMobile={setMobile} disabled={saving} />
        <TextField testID="add-staff-password" label="Initial password" value={password} onChangeText={setPassword} placeholder="At least 6 characters" secureTextEntry autoCapitalize="none" helper="This password remains valid until the owner changes it. The member cannot change it." />
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
  const [mobile, setMobile] = useState("");
  const [role, setRole] = useState("");
  const [teamRole, setTeamRole] = useState("");
  const [active, setActive] = useState(true);
  const [delegation, setDelegation] = useState<DelegationState>(emptyDelegation);
  const [grantsLoading, setGrantsLoading] = useState(true);
  const [grantsError, setGrantsError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [username, setUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const originalDelegation = useRef<DelegationState | null>(null);
  // Commit saved form values before the sheet accepts input. A passive effect
  // can restore an old contact after the user has already cleared the field.
  useLayoutEffect(() => {
    if (!staff) return;
    setUsername(optionalContact(staff.login_id) || "");
    setEmail(optionalContact(staff.email) || ""); setMobile(optionalContact(staff.mobile) || "");
    setFullName(staff.full_name); setPhone(optionalContact(staff.phone) || ""); setRole(staff.role === "owner" ? "owner" : "worker");
    setTeamRole(optionalContact(staff.team_role) || ""); setActive(staff.active); setSaveError(null);
  }, [staff]);
  useEffect(() => {
    let alive = true;
    if (!staff || !options) return;
    setGrantsLoading(true); setGrantsError(null);
    originalDelegation.current = null;
    setDelegation(emptyDelegation());
    api.get<{ floor_ids?: string[]; grants: DelegationGrant[] }>(`/settings/access-grants/${staff.id}`).then((response) => {
      if (alive) {
        const current = loadDelegation(response.floor_ids ?? staff.floor_ids ?? [], response.grants, options.catalog.resources);
        originalDelegation.current = current;
        setDelegation(current);
      }
    }).catch((cause: unknown) => { if (alive) setGrantsError(teamErrorMessage(cause, "Could not load this person’s access")); })
      .finally(() => { if (alive) setGrantsLoading(false); });
    return () => { alive = false; };
  }, [staff, options, retryCount]);
  if (!staff) return null;
  const isSelf = staff.id === selfId;
  const protectedOwner = staff.role === "owner" && staff.active;
  const accessChanged = role !== (staff.role === "owner" ? "owner" : "worker") || active !== staff.active || (!!originalDelegation.current && JSON.stringify(delegation) !== JSON.stringify(originalDelegation.current));
  const accessUnavailable = !options || optionsError || grantsLoading || !!grantsError;
  const save = async () => {
    if (saving || resetting || deleting) return;
    if (!fullName.trim()) { setSaveError("Full name is required"); return; }
    const contactError = validateTeamContacts(email, username, phone, mobile);
    if (contactError) { setSaveError(contactError); return; }
    if (!isSelf && accessChanged && accessUnavailable) { setSaveError("Load this person’s access before changing it"); return; }
    setSaving(true); setSaveError(null);
    try {
      const patch: Record<string, unknown> = {};
      const contact = { full_name: fullName.trim(), login_id: optionalContact(username), email: optionalContact(email)?.toLowerCase() || null, phone: optionalContact(phone), mobile: optionalContact(mobile), team_role: optionalContact(teamRole) };
      for (const [key, value] of Object.entries(contact)) {
        const original = key === "full_name" ? staff.full_name : optionalContact(staff[key as keyof Staff]);
        if (value !== original) patch[key] = value;
      }
      if (!isSelf && accessChanged) {
        const owner = role === "owner";
        Object.assign(patch, { role, active, access_profile: null, custom_access: !owner, floor_ids: owner ? [] : delegation.floorIds });
        if (!owner) patch.access_grants = delegation.grants;
      }
      if (Object.keys(patch).length) await api.patch(`/team/${staff.id}`, patch);
      toast.success("Team member and access saved"); onSaved();
    } catch (cause: unknown) { setSaveError(teamErrorMessage(cause, "Could not update team member")); }
    finally { setSaving(false); }
  };
  const resetPassword = async (generated = false) => {
    if (saving || resetting || deleting || isSelf) return;
    setPasswordError(null);
    if (!generated && !hasMinimumPasswordLength(newPassword)) { setPasswordError("Password must be at least 6 characters"); return; }
    if (!generated && newPassword !== confirmPassword) { setPasswordError("Passwords don't match"); return; }
    setResetting(true);
    try {
      const result = await api.post<TempPasswordResult>(`/team/${staff.id}/reset-password`, generated ? undefined : { new_password: newPassword });
      setNewPassword(""); setConfirmPassword("");
      onClose(); onPasswordReset(result);
    } catch (cause: unknown) { setPasswordError(teamErrorMessage(cause, "Could not change password")); }
    finally { setResetting(false); }
  };
  const deleteMember = async () => {
    if (saving || resetting || deleting || isSelf || protectedOwner) return;
    setDeleting(true);
    try {
      await api.delete(`/team/${staff.id}`);
      toast.success("Team member deleted"); setDeleteOpen(false); onSaved();
    } catch (cause: unknown) { setSaveError(teamErrorMessage(cause, "Could not delete team member")); setDeleteOpen(false); }
    finally { setDeleting(false); }
  };
  return <Sheet visible={!!staff} width={720} onClose={() => { if (!saving && !resetting && !deleting) onClose(); }} title={staff.full_name} subtitle={optionalContact(staff.email) || undefined} testID="edit-staff-sheet">
    <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={styles.form} keyboardShouldPersistTaps="handled">
        <TextField testID="edit-staff-name" label="Full name" value={fullName} onChangeText={setFullName} />
        <TextField testID="edit-staff-username" label="Username" value={username} onChangeText={setUsername} placeholder="Optional sign-in username" autoCapitalize="none" autoCorrect={false} maxLength={120} editable={!saving && !resetting && !deleting} />
        <ContactFields prefix="edit-staff" email={email} onEmail={setEmail} phone={phone} onPhone={setPhone} mobile={mobile} onMobile={setMobile} disabled={saving || resetting || deleting} />
        <TextField testID="edit-staff-team-role" label="Team role name" value={teamRole} onChangeText={setTeamRole} placeholder="e.g. Ground Floor Sales" maxLength={80} />
        <AccountAccessPicker value={role} onChange={setRole} disabled={isSelf || protectedOwner || saving} prefix="edit-staff" />
        {protectedOwner && !isSelf ? <Text testID="edit-staff-owner-protected" style={type.caption}>Active owners keep full access and cannot be disabled, demoted or deleted.</Text> : null}
        <View style={styles.switchRow}>
          <View style={{ flex: 1 }}><Text style={type.bodyStrong}>Account enabled</Text><Text style={type.caption}>{isSelf ? "You can’t disable your own account." : protectedOwner ? "Active owner accounts stay enabled." : "Turn off to block sign-in immediately."}</Text></View>
          <Switch testID="edit-staff-active-switch" value={active} onValueChange={setActive} disabled={isSelf || protectedOwner || saving} />
        </View>
        {isSelf ? <Text style={type.caption}>You can’t change your own account access.</Text> : role === "owner" ? <Text style={type.caption}>An owner has full access to all floors and pages.</Text> : grantsError ? <ErrorState title="Current access unavailable" subtitle={grantsError} onRetry={() => setRetryCount((count) => count + 1)} /> : grantsLoading ? <Text style={type.caption}>Loading this person’s access…</Text> : <DelegationOptions options={options} error={optionsError} onRetry={onRetry} value={delegation} onChange={setDelegation} disabled={saving} />}
        {saveError ? <Text accessibilityRole="alert" style={[type.caption, { color: colors.error }]}>{saveError}</Text> : null}
        <Button testID="edit-staff-save" label={saving ? "Saving…" : "Save changes"} variant="primary" icon="check" disabled={saving || resetting || deleting || (!isSelf && accessChanged && accessUnavailable)} onPress={save} fullWidth />
        <View style={styles.divider} />
        {isSelf ? <Text style={type.caption}>Use Settings → Change password to update your own password.</Text> : <>
          <Text accessibilityRole="header" style={type.titleSm}>Change member password</Text>
          <Text style={type.caption}>Only the owner can change this member’s password. Changing it signs them out of every device.</Text>
          <TextField testID="edit-staff-password" label="New password" value={newPassword} onChangeText={setNewPassword} secureTextEntry autoCapitalize="none" editable={!resetting && !deleting && !saving} placeholder="At least 6 characters" />
          <TextField testID="edit-staff-confirm-password" label="Confirm new password" value={confirmPassword} onChangeText={setConfirmPassword} secureTextEntry autoCapitalize="none" editable={!resetting && !deleting && !saving} error={passwordError} />
          <Button testID="edit-staff-set-password" label="Save entered password" variant="primary" icon="key" loading={resetting} disabled={saving || deleting} onPress={() => void resetPassword()} fullWidth />
          <Text testID="edit-staff-set-password-help" style={type.caption}>Saves the password you entered and confirmed above.</Text>
          <Button testID="edit-staff-reset-password" label="Generate and save random password" variant="secondary" icon="refresh-cw" disabled={resetting || saving || deleting} onPress={() => void resetPassword(true)} fullWidth />
          <Text testID="edit-staff-generate-password-help" style={type.caption}>Creates and saves a random password immediately. It ignores the fields above. Share the new password using the delivery shown after saving.</Text>
          <Text style={type.caption}>The password applies only to this member and remains valid until the owner changes it.</Text>
          <View style={styles.divider} />
          {!protectedOwner ? <Button testID="edit-staff-delete" label="Delete team member" variant="danger" icon="trash-2" disabled={resetting || saving || deleting} onPress={() => setDeleteOpen(true)} fullWidth /> : null}
        </>}
      </ScrollView>
    </KeyboardAvoidingView>
    <ConfirmDialog visible={deleteOpen} onClose={() => { if (!deleting) setDeleteOpen(false); }} onConfirm={() => void deleteMember()} title="Delete team member?" description={`This removes ${staff.full_name} from the team and blocks their sign-in on every device. Business records remain available.`} confirmLabel="Delete member" tone="danger" loading={deleting} testID="confirm-delete-team-member" />
  </Sheet>;
}

const styles = StyleSheet.create({
  contactColumn: { flexGrow: 1, flexBasis: 180, minWidth: 0 },
  form: { padding: spacing.xl, gap: spacing.lg },
  card: { backgroundColor: colors.surfaceSecondary, borderRadius: radius.lg, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.border, padding: spacing.md },
  switchRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, backgroundColor: colors.surfaceSecondary, borderRadius: radius.md, borderWidth: 1, borderColor: colors.border, padding: spacing.md },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: colors.divider, marginVertical: spacing.xs },
});
