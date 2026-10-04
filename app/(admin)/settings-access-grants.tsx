// Settings > Team > Personal access.  Unlike the legacy role visibility
// matrix, these grants are enforced by the API and are intentionally scoped
// to one person, one business surface, optional floor, and explicit actions.
import Feather from "@expo/vector-icons/Feather";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";

import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { Button, Card, Chip, EmptyState, ErrorState, LoadingState } from "@/src/components/ui";
import { api } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { useAuth } from "@/src/state/auth";
import { colors, spacing, type } from "@/src/theme/tokens";

type Staff = { id: string; full_name: string; role: string; active: boolean };
type Floor = { id: string; name: string };
type Resource = { key: string; label: string; actions: Action[] };
type Action = "view" | "create" | "update" | "delete" | "export";
type Grant = { id: string; resource: string; actions: Action[]; floor_id: string | null; expires_at: string | null };

const ACTION_LABELS: Record<Action, string> = {
  view: "View only", create: "Create", update: "Edit", delete: "Delete", export: "Export",
};

export default function SettingsAccessGrants() {
  const { staff: me } = useAuth();
  const canManage = me?.role === "owner" || me?.role === "admin";
  const [staff, setStaff] = useState<Staff[]>([]);
  const [floors, setFloors] = useState<Floor[]>([]);
  const [resources, setResources] = useState<Resource[]>([]);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState("payments");
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [actions, setActions] = useState<Action[]>(["view"]);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [grantError, setGrantError] = useState<string | null>(null);

  const loadOptions = useCallback(() => {
    setOptionsLoading(true); setOptionsError(null);
    Promise.all([
      api.get<Staff[]>("/team"), api.get<Floor[]>("/settings/floors"),
      api.get<{ resources: Resource[] }>("/settings/access-grants/resources"),
    ]).then(([people, availableFloors, catalog]) => {
      const activePeople = people.filter((person) => person.active && person.id !== me?.id);
      setStaff(activePeople); setFloors(availableFloors); setResources(catalog.resources);
      setSelectedUserId((current) => current || activePeople[0]?.id || null);
    }).catch((error: any) => setOptionsError(error?.detail || "Could not load delegation controls")).finally(() => setOptionsLoading(false));
  }, [me?.id]);
  useEffect(loadOptions, [loadOptions]);

  const loadGrants = useCallback(async () => {
    if (!selectedUserId) { setGrants([]); return; }
    setGrants(null); setGrantError(null);
    try {
      const response = await api.get<{ grants: Grant[] }>(`/settings/access-grants/${selectedUserId}`);
      setGrants(response.grants);
    } catch (error: any) {
      setGrantError(error?.detail || "Could not load this person's access");
    }
  }, [selectedUserId]);
  useEffect(() => { void loadGrants(); }, [loadGrants]);

  const selectedPerson = staff.find((person) => person.id === selectedUserId);
  const selectedResourceInfo = resources.find((resource) => resource.key === selectedResource);
  const visibleActions = selectedResourceInfo?.actions || [];
  const summary = useMemo(() => {
    if (!selectedPerson) return "Choose a staff member to set their exact access.";
    return `Any access set here is enforced server-side. ${selectedPerson.full_name} will be signed out so the new limits take effect immediately.`;
  }, [selectedPerson]);

  const toggleAction = (action: Action) => setActions((current) => (
    current.includes(action) ? current.filter((value) => value !== action) : [...current, action]
  ));
  const save = async () => {
    if (!selectedUserId || actions.length === 0) return;
    setSaving(true);
    try {
      await api.post(`/settings/access-grants/${selectedUserId}`, {
        resource: selectedResource, actions, floor_id: selectedFloorId,
      });
      toast.success("Personal access saved — the worker will need to sign in again");
      await loadGrants();
    } catch (error: any) { toast.error(error?.detail || "Could not save access"); }
    finally { setSaving(false); }
  };
  const remove = async (grant: Grant) => {
    if (!selectedUserId) return;
    setSaving(true);
    try {
      await api.delete(`/settings/access-grants/${selectedUserId}/${grant.id}`);
      toast.success("Access removed"); await loadGrants();
    } catch (error: any) { toast.error(error?.detail || "Could not remove access"); }
    finally { setSaving(false); }
  };

  return (
    <AdminPage title="Personal access" subtitle="Give each worker only the pages and actions they need">
      {!canManage ? <EmptyState icon="lock" title="Owner or admin access required" subtitle="Ask an owner or admin to set personal access." /> : optionsLoading ? <LoadingState label="Loading access controls…" /> : optionsError ? <ErrorState title="Access controls unavailable" subtitle={optionsError} onRetry={loadOptions} /> : (
        <View style={styles.page}>
          <Card style={styles.notice}>
            <Feather name="shield" size={18} color={colors.brand} />
            <Text style={[type.caption, { flex: 1 }]}>{summary}</Text>
          </Card>
          <Section label="TEAM MEMBER">
            <View style={styles.chips}>{staff.map((person) => <Chip key={person.id} label={person.full_name} active={person.id === selectedUserId} onPress={() => setSelectedUserId(person.id)} />)}</View>
          </Section>
          <Section label="PAGE OR WORKSPACE">
            <View style={styles.chips}>{resources.map((resource) => <Chip key={resource.key} label={resource.label} active={resource.key === selectedResource} onPress={() => { setSelectedResource(resource.key); setActions(["view"]); }} />)}</View>
          </Section>
          <Section label="FLOOR SCOPE">
            <View style={styles.chips}>
              <Chip label="All assigned floors" active={selectedFloorId === null} onPress={() => setSelectedFloorId(null)} />
              {floors.map((floor) => <Chip key={floor.id} label={floor.name} active={selectedFloorId === floor.id} onPress={() => setSelectedFloorId(floor.id)} />)}
            </View>
          </Section>
          <Section label="ALLOWED ACTIONS">
            <View style={styles.chips}>{visibleActions.map((action) => <Chip key={action} label={ACTION_LABELS[action]} active={actions.includes(action)} onPress={() => toggleAction(action)} />)}</View>
            <Text style={styles.help}>For a read-only Payments worker, choose Payments, their floor, and View only.</Text>
          </Section>
          <Button label="Save personal access" icon="shield" fullWidth loading={saving} disabled={!selectedUserId || actions.length === 0 || saving} onPress={save} />

          <Section label="ACTIVE ACCESS">
            {grantError ? <ErrorState title="Current access unavailable" subtitle={grantError} onRetry={() => void loadGrants()} /> : grants === null ? <ActivityIndicator color={colors.brand} /> : grants.length === 0 ? <Text style={type.caption}>This person is using their standard role access.</Text> : grants.map((grant) => (
              <Card key={grant.id} style={styles.grant}>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text style={type.bodyStrong}>{resources.find((resource) => resource.key === grant.resource)?.label || grant.resource}</Text>
                  <Text style={type.caption}>{grant.actions.map((action) => ACTION_LABELS[action]).join(" · ")} · {floors.find((floor) => floor.id === grant.floor_id)?.name || "All assigned floors"}</Text>
                </View>
                <Pressable accessibilityRole="button" accessibilityLabel="Remove personal access" disabled={saving} onPress={() => { void remove(grant); }} style={styles.remove}><Feather name="trash-2" size={16} color={colors.error} /></Pressable>
              </Card>
            ))}
          </Section>
        </View>
      )}
    </AdminPage>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={{ gap: spacing.sm }}><Text style={type.label}>{label}</Text>{children}</View>;
}

const styles = StyleSheet.create({
  page: { gap: spacing.lg, paddingBottom: spacing.xxxl },
  notice: { flexDirection: "row", gap: spacing.sm, alignItems: "flex-start" },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  help: { ...type.caption, marginTop: spacing.xs },
  grant: { flexDirection: "row", gap: spacing.md, alignItems: "center" },
  remove: { width: 40, height: 40, alignItems: "center", justifyContent: "center" },
});
