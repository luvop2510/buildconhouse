import { useEffect, useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Sheet } from "@/src/components/ds";
import { kitchenProjectsApi, type KitchenAssignee, type KitchenProject, type KitchenStage } from "@/src/api/kitchenProjects";
import { KitchenButton as Button, kitchenType as type } from "./KitchenPrimitives";
import { KitchenPanel } from "./shared";
import { useKitchenProject } from "./KitchenProjectState";
import { spacing } from "@/src/theme/tokens";

export function AssigneeChoice({ value, name, onChange, disabled, filter = false, testID = "kitchen-assignee" }: { value: string; name?: string | null; onChange: (id: string) => void; disabled?: boolean; filter?: boolean; testID?: string }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<KitchenAssignee[]>([]);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setLoading(true); setError(false);
    kitchenProjectsApi.assignees(controller.signal).then(result => { if (!controller.signal.aborted) setRows(result.rows); })
      .catch(() => { if (!controller.signal.aborted) setError(true); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [open, retry]);
  const choose = (id: string) => { setOpen(false); onChange(id); };
  return <View style={{ gap: spacing.sm }}>
    <Text style={type.label}>Assigned to</Text>
    <Button label={rows.find(row => row.id === value)?.full_name || name || (filter ? value === "unassigned" ? "Unassigned" : value ? "Selected employee" : "Any employee" : value ? "Selected employee" : "Unassigned")} variant="secondary" disabled={disabled} onPress={() => setOpen(true)} testID={testID} />
    <Sheet scroll visible={open} onClose={() => setOpen(false)} title="Select responsible employee">
      {loading ? <Text style={type.body}>Loading employees…</Text> : error ? <Button label="Retry employee list" onPress={() => setRetry(current => current + 1)} /> : <View style={{ gap: spacing.sm }}>
        {filter ? <Button label="Any employee" variant="secondary" onPress={() => choose("")} /> : null}
        <Button label="Unassigned" variant="secondary" onPress={() => choose(filter ? "unassigned" : "")} testID={`${testID}-none`} />
        {rows.map(row => <Button key={row.id} label={row.full_name} variant="secondary" onPress={() => choose(row.id)} testID={`${testID}-${row.id}`} />)}
      </View>}
    </Sheet>
  </View>;
}

export function KitchenAssignment({ project, stage, disabled }: { project: KitchenProject; stage: KitchenStage; disabled: boolean }) {
  const { command } = useKitchenProject();
  const id = project.assignments[stage] || "";
  return <KitchenPanel>
    {project.permissions?.can_assign && stage === project.stage && stage !== "completed" ? <AssigneeChoice value={id} name={project.assigned_to_name} disabled={disabled} onChange={user_id => { void command("assign", { stage, user_id: user_id || null }); }} /> : <Text style={type.body}>Assigned to: {stage === project.stage ? project.assigned_to_name || "Unassigned" : id ? "Recorded in stage history" : "Unassigned"}</Text>}
    <Text style={type.caption}>The owner selects the responsible employee. Assignment does not restrict stage navigation.</Text>
  </KitchenPanel>;
}
