// BuildCon House · Team — Settings > Team. Full CRUD: view, add, edit,
// disable/enable, assign role, reset password. Roles are NEVER hardcoded
// here — the "Assign role" picker is populated entirely from GET /api/roles
// via useRoles() (auth.ROLE_HIERARCHY on the backend is the single source
// of truth). If a role is renamed/added server-side, this screen updates
// with zero code changes.
import { Feather } from "@expo/vector-icons";
import { useCallback, useEffect, useState } from "react";
import {
  KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, View,
} from "react-native";

import { AdminPage, IconAction } from "@/src/components/AdminPage";
import { Avatar, Badge, Button, Chip, EmptyState, ErrorState, Sheet, Skeleton, TextField } from "@/src/components/ui";
import { TempPasswordDialog, TempPasswordResult } from "@/src/components/TempPasswordDialog";
import { api } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { useRoles } from "@/src/hooks/use-roles";
import { useAuth } from "@/src/state/auth";
import { useBp } from "@/src/design/responsive";
import { AccessProfile, PROFILE_PROVISIONING } from "@/src/access-profiles";
import { colors, radius, spacing, type } from "@/src/theme/tokens";

type Staff = {
  id: string; full_name: string; email: string; role: string;
  phone?: string | null; active: boolean; floor_ids?: string[]; access_profile?: AccessProfile | null;
};
type Floor = { id: string; name: string; slug: string };
type GrantAction = "view" | "create" | "update" | "delete" | "export";
type GrantResource = { key: string; label: string; actions: GrantAction[] };
type Allocation = { id: string; resource: string; actions: GrantAction[]; floor_id: string | null };
type AllocationDraft = Omit<Allocation, "id">;

const ACTION_LABELS: Record<GrantAction, string> = {
  view: "View", create: "Create", update: "Edit", delete: "Delete", export: "Export",
};

export default function Team() {
  const { isPhone } = useBp();
  const { staff: me } = useAuth();
  const { roles } = useRoles();
  const [floors, setFloors] = useState<Floor[]>([]);
  const [items, setItems] = useState<Staff[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [floorError, setFloorError] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [editing, setEditing] = useState<Staff | null>(null);
  const [tempResult, setTempResult] = useState<TempPasswordResult | null>(null);
  const [tempDialogOpen, setTempDialogOpen] = useState(false);

  const load = useCallback(() => {
    setLoadError(false);
    api.get<Staff[]>("/team").then(setItems).catch(() => setLoadError(true));
  }, []);
  useEffect(() => { load(); }, [load]);
  const loadFloors = useCallback(() => { setFloorError(false); api.get<Floor[]>("/settings/floors").then(setFloors).catch(() => setFloorError(true)); }, []);
  useEffect(loadFloors, [loadFloors]);

  return (
    <AdminPage
      title="Team"
      subtitle="Roles, access & performance"
      right={<IconAction icon="user-plus" label="Add" onPress={() => setAddOpen(true)} testID="team-add-btn" />}
    >
      {floorError ? <ErrorState title="Department options unavailable" subtitle="Retry before assigning staff access." onRetry={loadFloors} /> : null}
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
                  <Badge label={roleInfo?.label || u.role} tone={u.active ? "brand" : "neutral"} size="sm" />
                  {!u.active ? <Badge label="Disabled" tone="warning" size="sm" /> : null}
                </View>
                <Feather name="chevron-right" size={16} color={colors.onSurfaceMuted} />
              </Pressable>
            );
          })}
        </View>
      )}

      <AddStaffSheet visible={addOpen} floors={floors} onClose={() => setAddOpen(false)} onCreated={load} />
      <EditStaffSheet
        staff={editing}
        floors={floors}
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

// ──────────────────────────────────────────────────────────────────────────
// Add Staff
// ──────────────────────────────────────────────────────────────────────────
function AddStaffSheet({ visible, floors, onClose, onCreated }: { visible: boolean; floors: Floor[]; onClose: () => void; onCreated: () => void }) {
  const { roles } = useRoles();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<string>("");
  const [floorIds, setFloorIds] = useState<string[]>([]);
  const [accessProfile, setAccessProfile] = useState<AccessProfile | null>(null);
  const [allocations, setAllocations] = useState<Allocation[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Default to the lowest-privilege assignable role once roles load — never
  // a hardcoded string; if the role list is empty (still loading) this is "".
  useEffect(() => {
    if (!role && roles.length > 0) setRole(roles[roles.length - 1].role);
  }, [roles, role]);

  const reset = () => { setFullName(""); setEmail(""); setPhone(""); setPassword(""); setFloorIds([]); setAccessProfile(null); setAllocations([]); setError(null); };

  const save = async () => {
    if (!fullName.trim()) { setError("Full name is required"); return; }
    if (!email.trim()) { setError("Email is required"); return; }
    if (password.length < 12) { setError("Initial password must be at least 12 characters"); return; }
    if (!role) { setError("Select a role"); return; }
    if (!accessProfile && !["owner", "manager"].includes(role) && floorIds.length === 0) {
      setError("Assign at least one floor for a non-owner/non-manager account"); return;
    }
    setSaving(true);
    try {
      const member = await api.post<Staff>("/team", { full_name: fullName.trim(), email: email.trim(), phone: phone.trim() || null, password, role, floor_ids: floorIds, access_profile: accessProfile });
      // The member must exist before their exact page/action allocations can
      // be persisted. Each grant is server-enforced and floor-scoped.
      for (const allocation of allocations) {
        await api.post(`/settings/access-grants/${member.id}`, allocation);
      }
      toast.success("Team member added — they must set their own password on first sign-in");
      reset();
      onCreated();
      onClose();
    } catch (e: any) {
      setError(e?.detail || "Could not add team member");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet visible={visible} onClose={() => { reset(); onClose(); }} title="Add staff" testID="add-staff-sheet">
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }} keyboardShouldPersistTaps="handled">
          <TextField testID="add-staff-name" label="Full name" value={fullName} onChangeText={setFullName} placeholder="e.g. Priya Sharma" autoFocus />
          <TextField testID="add-staff-email" label="Email" value={email} onChangeText={setEmail} placeholder="name@company.com" autoCapitalize="none" keyboardType="email-address" />
          <TextField testID="add-staff-phone" label="Phone" value={phone} onChangeText={setPhone} placeholder="Optional" keyboardType="phone-pad" />
          <TextField testID="add-staff-password" label="Initial password" value={password} onChangeText={setPassword} placeholder="At least 12 characters" secureTextEntry autoCapitalize="none" helper="They'll be asked to set their own password on first login." error={error} />
          <ProfileProvisioner value={accessProfile} onChange={(profile) => {
            setAccessProfile(profile);
            if (profile) {
              const provision = PROFILE_PROVISIONING[profile];
              setFloorIds([provision.floorId]);
              setRole(provision.minimumRole);
            }
          }} />
          <View style={{ gap: 6 }}>
            <Text style={type.label}>Role</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
              {roles.map((r) => (
                <Chip key={r.role} label={r.label} active={role === r.role} onPress={() => setRole(r.role)} testID={`add-staff-role-${r.role}`} />
              ))}
            </View>
          </View>
          <FloorPicker floors={floors} value={floorIds} onChange={setFloorIds} hint={accessProfile ? "This profile is safely pinned to its required floor." : "Owners and managers automatically see every floor. Other accounts require at least one floor."} disabled={!!accessProfile} />
          <CustomAllocationEditor
            floors={floors}
            allowedFloorIds={floorIds}
            allocations={allocations}
            onCreate={async (allocation) => {
              setAccessProfile(null);
              setAllocations((current) => [...current, { ...allocation, id: `draft-${allocation.floor_id}-${allocation.resource}` }]);
            }}
            onRemove={async (allocation) => setAllocations((current) => current.filter((item) => item.id !== allocation.id))}
          />
          <Button testID="add-staff-save" label={saving ? "Adding…" : "Add staff member"} variant="primary" size="lg" icon="check" disabled={saving} onPress={save} fullWidth />
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Edit Staff (role, active, reset password)
// ──────────────────────────────────────────────────────────────────────────
function EditStaffSheet({
  staff, floors, selfId, onClose, onSaved, onPasswordReset,
}: {
  staff: Staff | null;
  floors: Floor[];
  selfId?: string;
  onClose: () => void;
  onSaved: () => void;
  onPasswordReset: (result: TempPasswordResult) => void;
}) {
  const { roles } = useRoles();
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState("");
  const [active, setActive] = useState(true);
  const [floorIds, setFloorIds] = useState<string[]>([]);
  const [accessProfile, setAccessProfile] = useState<AccessProfile | null>(null);
  const [allocations, setAllocations] = useState<Allocation[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    if (staff) {
      setFullName(staff.full_name);
      setPhone(staff.phone || "");
      setRole(staff.role);
      setActive(staff.active);
      setFloorIds(staff.floor_ids || []);
      setAccessProfile(staff.access_profile || null);
      setAllocations(null);
      api.get<{ grants: Allocation[] }>(`/settings/access-grants/${staff.id}`)
        .then((response) => setAllocations(response.grants))
        .catch(() => setAllocations([]));
    }
  }, [staff]);

  if (!staff) return null;
  const isSelf = staff.id === selfId;

  const save = async () => {
    setSaving(true);
    try {
      const patch: Record<string, any> = { full_name: fullName.trim(), phone: phone.trim() || null };
      if (!isSelf) { patch.role = role; patch.active = active; }
      if (!isSelf) {
        if (!accessProfile && !["owner", "manager"].includes(role) && floorIds.length === 0) {
          toast.error("Assign at least one floor for a non-owner/non-manager account"); return;
        }
        patch.floor_ids = floorIds;
        patch.access_profile = accessProfile;
      }
      await api.patch(`/team/${staff.id}`, patch);
      toast.success("Team member updated");
      onSaved();
    } catch (e: any) {
      toast.error(e?.detail || "Could not update team member");
    } finally {
      setSaving(false);
    }
  };

  const resetPassword = async () => {
    setResetting(true);
    try {
      const res = await api.post<TempPasswordResult>(`/team/${staff.id}/reset-password`);
      onClose();
      onPasswordReset(res);
    } catch (e: any) {
      toast.error(e?.detail || "Could not reset password");
    } finally {
      setResetting(false);
    }
  };

  return (
    <Sheet visible={!!staff} onClose={onClose} title={staff.full_name} subtitle={staff.email} testID="edit-staff-sheet">
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : "height"} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.lg }} keyboardShouldPersistTaps="handled">
          <TextField testID="edit-staff-name" label="Full name" value={fullName} onChangeText={setFullName} />
          <TextField testID="edit-staff-phone" label="Phone" value={phone} onChangeText={setPhone} keyboardType="phone-pad" placeholder="Optional" />

          <View style={{ gap: 6 }}>
            <Text style={type.label}>Role</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
              {roles.map((r) => (
                <Chip
                  key={r.role}
                  label={r.label}
                  active={role === r.role}
                  onPress={() => !isSelf && setRole(r.role)}
                  testID={`edit-staff-role-${r.role}`}
                />
              ))}
            </View>
            {isSelf ? <Text style={type.caption}>You can&apos;t change your own role.</Text> : null}
          </View>

          <View style={styles.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={type.bodyStrong}>Account enabled</Text>
              <Text style={type.caption}>{isSelf ? "You can't disable your own account." : "Turn off to block sign-in immediately."}</Text>
            </View>
            <Switch testID="edit-staff-active-switch" value={active} onValueChange={setActive} disabled={isSelf} />
          </View>

          {!isSelf ? <ProfileProvisioner value={accessProfile} onChange={(profile) => {
            setAccessProfile(profile);
            if (profile) {
              const provision = PROFILE_PROVISIONING[profile];
              setFloorIds([provision.floorId]);
              setRole(provision.minimumRole);
            }
          }} /> : null}

          <FloorPicker floors={floors} value={floorIds} onChange={setFloorIds} hint={accessProfile ? "This profile is safely pinned to its required floor." : "Owners and managers automatically see every floor. Other accounts require at least one floor."} disabled={isSelf || !!accessProfile} />

          {!isSelf ? <CustomAllocationEditor
            floors={floors}
            allowedFloorIds={floorIds}
            allocations={allocations || []}
            loading={allocations === null}
            onCreate={async (allocation) => {
              // Persist the selected floors and clear a preset before writing
              // a grant. Otherwise the prior profile/floor claim could still
              // reject a newly allocated page until someone separately saved
              // the rest of this sheet.
              await api.patch(`/team/${staff.id}`, { floor_ids: floorIds, access_profile: null });
              setAccessProfile(null);
              await api.post(`/settings/access-grants/${staff.id}`, allocation);
              const response = await api.get<{ grants: Allocation[] }>(`/settings/access-grants/${staff.id}`);
              setAllocations(response.grants);
              toast.success("Custom allocation saved — their active sessions were signed out");
            }}
            onRemove={async (allocation) => {
              await api.delete(`/settings/access-grants/${staff.id}/${allocation.id}`);
              setAllocations((current) => (current || []).filter((item) => item.id !== allocation.id));
              toast.success("Custom allocation removed");
            }}
          /> : null}

          <Button testID="edit-staff-save" label={saving ? "Saving…" : "Save changes"} variant="primary" icon="check" disabled={saving} onPress={save} fullWidth />

          <View style={styles.divider} />

          <Button
            testID="edit-staff-reset-password"
            label={resetting ? "Generating…" : "Reset password"}
            variant="secondary"
            icon="key"
            disabled={resetting || isSelf}
            onPress={resetPassword}
            fullWidth
          />
          {isSelf ? (
            <Text style={type.caption}>Use Settings &gt; Change password to update your own password.</Text>
          ) : (
            <Text style={type.caption}>Generates a temporary password shown once &mdash; share it with them directly.</Text>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}

function ProfileProvisioner({ value, onChange }: { value: AccessProfile | null; onChange: (profile: AccessProfile | null) => void }) {
  return <View style={{ gap: 6 }}>
    <Text style={type.label}>Access profile</Text>
    <Text style={type.caption}>Profiles set the minimum role and exact floor automatically. Clear a profile to manage role and floors manually.</Text>
    <View style={{ gap: spacing.xs }}>
      <Chip label="No profile (manual access)" active={!value} onPress={() => onChange(null)} testID="staff-profile-none" />
      {(Object.entries(PROFILE_PROVISIONING) as [AccessProfile, typeof PROFILE_PROVISIONING[AccessProfile]][]).map(([profile, item]) => (
        <View key={profile} style={{ gap: 2 }}>
          <Chip label={item.label} active={value === profile} onPress={() => onChange(profile)} testID={`staff-profile-${profile}`} />
          {value === profile ? <Text style={type.caption}>{item.description}</Text> : null}
        </View>
      ))}
    </View>
  </View>;
}

function FloorPicker({ floors, value, onChange, hint, disabled }: { floors: Floor[]; value: string[]; onChange: (ids: string[]) => void; hint: string; disabled?: boolean }) {
  return (
    <View style={{ gap: 6 }}>
      <Text style={type.label}>Floor access</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {floors.map((floor) => {
          const active = value.includes(floor.id);
          return <Chip key={floor.id} label={floor.name} active={active} onPress={() => { if (disabled) return; onChange(active ? value.filter((id) => id !== floor.id) : [...value, floor.id]); }} />;
        })}
      </View>
      <Text style={type.caption}>{hint}</Text>
    </View>
  );
}

/**
 * Builds a least-privilege allocation in the natural business order: floor,
 * then page, then the exact permitted actions. The backend treats every saved
 * item as an API allow-list, not merely a navigation preference.
 */
function CustomAllocationEditor({
  floors, allowedFloorIds, allocations, loading, onCreate, onRemove,
}: {
  floors: Floor[];
  allowedFloorIds: string[];
  allocations: Allocation[];
  loading?: boolean;
  onCreate: (allocation: AllocationDraft) => Promise<void>;
  onRemove: (allocation: Allocation) => Promise<void>;
}) {
  const [resources, setResources] = useState<GrantResource[]>([]);
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState("");
  const [actions, setActions] = useState<GrantAction[]>(["view"]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get<{ resources: GrantResource[] }>("/settings/access-grants/resources")
      .then((response) => {
        setResources(response.resources);
        setSelectedResource((current) => current || response.resources[0]?.key || "");
      })
      .catch(() => setResources([]));
  }, []);
  useEffect(() => {
    if (selectedFloorId && allowedFloorIds.includes(selectedFloorId)) return;
    setSelectedFloorId(allowedFloorIds[0] || null);
  }, [allowedFloorIds, selectedFloorId]);

  const availableFloors = floors.filter((floor) => allowedFloorIds.includes(floor.id));
  const resource = resources.find((item) => item.key === selectedResource);
  const toggleAction = (action: GrantAction) => setActions((current) => (
    current.includes(action) ? current.filter((item) => item !== action) : [...current, action]
  ));
  const add = async () => {
    if (!selectedFloorId) { toast.error("Select a floor before assigning pages"); return; }
    if (!resource || actions.length === 0) { toast.error("Choose a page and at least one action"); return; }
    setBusy(true);
    try {
      await onCreate({ resource: resource.key, floor_id: selectedFloorId, actions });
      setActions(["view"]);
    } catch (error: any) {
      toast.error(error?.detail || "Could not save custom allocation");
    } finally {
      setBusy(false);
    }
  };

  return <View style={styles.allocationPanel}>
    <View style={{ gap: 3 }}>
      <Text style={type.label}>Custom allocation</Text>
      <Text style={type.caption}>Choose a floor, then the page and exact actions this person can use. Custom allocation replaces broad role access for this person.</Text>
    </View>
    {availableFloors.length === 0 ? <Text style={type.caption}>First select one or more floors above to unlock page allocation.</Text> : <>
      <View style={{ gap: 6 }}>
        <Text style={type.label}>1. Floor</Text>
        <View style={styles.chips}>{availableFloors.map((floor) => <Chip key={floor.id} label={floor.name} active={selectedFloorId === floor.id} onPress={() => setSelectedFloorId(floor.id)} />)}</View>
      </View>
      <View style={{ gap: 6 }}>
        <Text style={type.label}>2. Page</Text>
        <View style={styles.chips}>{resources.map((item) => <Chip key={item.key} label={item.label} active={selectedResource === item.key} onPress={() => { setSelectedResource(item.key); setActions(["view"]); }} />)}</View>
      </View>
      <View style={{ gap: 6 }}>
        <Text style={type.label}>3. What can they do?</Text>
        <View style={styles.chips}>{(resource?.actions || []).map((action) => <Chip key={action} label={ACTION_LABELS[action]} active={actions.includes(action)} onPress={() => toggleAction(action)} />)}</View>
      </View>
      <Button label="Add custom allocation" variant="secondary" icon="shield" fullWidth disabled={busy || !selectedFloorId || !resource || actions.length === 0} loading={busy} onPress={add} />
    </>}
    <View style={{ gap: spacing.xs }}>
      <Text style={type.label}>Active allocations</Text>
      {loading ? <Text style={type.caption}>Loading allocations…</Text> : allocations.length === 0 ? <Text style={type.caption}>No custom allocations yet. Standard role access remains in effect.</Text> : allocations.map((allocation) => (
        <View key={allocation.id} style={styles.allocationRow}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={type.bodyStrong}>{resources.find((item) => item.key === allocation.resource)?.label || allocation.resource}</Text>
            <Text style={type.caption}>{floors.find((floor) => floor.id === allocation.floor_id)?.name || "All floors"} · {allocation.actions.map((action) => ACTION_LABELS[action]).join(" · ")}</Text>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="Remove custom allocation" disabled={busy} onPress={async () => {
            setBusy(true);
            try { await onRemove(allocation); } catch (error: any) { toast.error(error?.detail || "Could not remove custom allocation"); } finally { setBusy(false); }
          }} style={styles.removeAllocation}><Feather name="trash-2" size={16} color={colors.error} /></Pressable>
        </View>
      ))}
    </View>
  </View>;
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
  },
  switchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.divider,
    marginVertical: spacing.xs,
  },
  allocationPanel: {
    gap: spacing.md,
    backgroundColor: colors.surfaceSecondary,
    borderRadius: radius.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    padding: spacing.md,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  allocationRow: {
    flexDirection: "row",
    gap: spacing.md,
    alignItems: "center",
    padding: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
  },
  removeAllocation: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
});
