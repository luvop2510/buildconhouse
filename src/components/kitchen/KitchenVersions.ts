import type { KitchenProject, KitchenVersion } from "@/src/api/kitchenProjects";

/** Saved commercial context follows explicit IDs, even when newer drafts exist. */
export function kitchenOrderContext(project: KitchenProject) {
  const order = project.commercial_basis_invalidated ? undefined : project.orders?.at(-1);
  const activeOrder = order?.authorization_invalidated ? undefined : order;
  const quotation = activeOrder ? project.quotation_versions?.find(row => row.id === activeOrder.quotation_version_id) : undefined;
  const design = quotation ? project.design_versions?.find(row => row.id === quotation.design_version_id) : undefined;
  return { order: activeOrder, quotation, design };
}

export function kitchenOrderQuotations(project: KitchenProject) {
  return project.quotation_versions?.filter(quote => !project.design_revision_pending && quote.shared_date && quote.response === "Approved" && project.design_versions?.some(design => design.id === quote.design_version_id && design.response === "Approved" && design.handoff_date && (design.workflow_cycle ?? 1) === (project.workflow_cycle ?? 1))) || [];
}

export function kitchenDesignApproval(project: KitchenProject, design?: KitchenVersion) {
  if (!design) return undefined;
  let approval;
  for (const row of [...(project.approvals || [])].reverse()) {
    if (row.scope !== "customer_design" || row.subject_id !== design.id) continue;
    if (row.decision !== "Approved") break;
    approval = row;
  }
  return approval;
}

export function kitchenApprovalDate(at?: string) {
  if (!at) return undefined;
  const timestamp = new Date(at);
  return Number.isFinite(timestamp.getTime()) ? new Date(timestamp.getTime() + 330 * 60_000).toISOString().slice(0, 10) : undefined;
}

export function kitchenProductionStarted(project: KitchenProject) {
  const started = (work?: KitchenProject["production"]) => Boolean(work && (work.start_date || work.completion_date || work.status !== "Not Started"));
  if (started(project.production) || project.orders?.some(row => !row.authorization_invalidated && row.production_started)) return true;
  if (project.work_history?.some(row => (row.workflow_cycle ?? 1) === (project.workflow_cycle ?? 1) && started(row.production))) return true;
  for (const event of [...(project.activity || [])].reverse()) {
    const changes = event.payload?.changes as Record<string, { after?: KitchenProject["production"] }> | undefined;
    if (changes && "workflow_cycle" in changes) break;
    if (started(changes?.production?.after)) return true;
  }
  return false;
}
