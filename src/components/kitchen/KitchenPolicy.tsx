import { useState } from "react";
import { View } from "react-native";
import { Text } from "@/src/components/AppText";
import { Alert } from "@/src/components/ds";
import { KITCHEN_DECISION_CONTRACT, kitchenProjectsApi, type KitchenAssignee, type KitchenPolicy as Policy } from "@/src/api/kitchenProjects";
import { ErrorNotice, KitchenPanel, useKitchenSubmission } from "./shared";
import { spacing } from "@/src/theme/tokens";
import { KitchenButton as Button, kitchenType as type } from "./KitchenPrimitives";
import { KitchenOption } from "./KitchenFilters";
import { useAuth } from "@/src/state/auth";

export function KitchenPolicyEditor({ policy, workers, workerError, onSaved, onReload }: { policy: Policy; workers: KitchenAssignee[]; workerError?: boolean; onSaved: (value: Policy) => void; onReload: () => void }) {
  const { staff } = useAuth();
  const choices = staff?.role === "owner" && !workers.some(worker => worker.id === staff.id) ? [...workers, { id: staff.id, full_name: `${staff.full_name} (you)`, role: staff.role }] : workers;
  const [showRules, setShowRules] = useState(false);
  const [ids, setIds] = useState(policy.department_manager_user_ids || []);
  const [baseVersion, setBaseVersion] = useState(policy.version);
  const submission = useKitchenSubmission();
  const needsReconciliation = policy.version !== baseVersion;
  const selectionLocked = submission.busy || Boolean(workerError) || submission.stale || needsReconciliation;
  const names = (selected: string[]) => selected.map(id => choices.find(worker => worker.id === id)?.full_name || "Unavailable staff member").join(", ") || "No managers selected";
  const reconcile = (keepDraft: boolean) => { if (!keepDraft) setIds(policy.department_manager_user_ids || []); setBaseVersion(policy.version); submission.clearFeedback(); };
  const adopted = policy.decision_contract === KITCHEN_DECISION_CONTRACT;
  return <View style={{ gap: spacing.lg }}>
    <Alert tone={adopted ? "info" : "warning"} title={adopted ? "Resolved Kitchen policy" : "Apply the resolved Kitchen policy"} description={`Owner decisions dated 20 October 2026. Current policy version ${policy.version}. Saving explicitly adopts these rules and the selected department managers. Changed policy invalidates earlier manager approvals.`} />
    <ErrorNotice error={submission.error} stale={submission.stale} onReload={onReload} recordLabel="settings record" />
    {needsReconciliation ? <KitchenPanel title="Review changed department managers">
      <Text accessibilityLiveRegion="polite" style={type.body}>Settings changed from version {baseVersion} to {policy.version}. Review the current managers before saving your selection.</Text>
      <Text style={type.bodyStrong}>Current managers: {names(policy.department_manager_user_ids || [])}</Text>
      <Text style={type.body}>Your unsaved selection: {names(ids)}</Text>
      <Button label="Use current managers" variant="secondary" onPress={() => reconcile(false)} testID="kitchen-policy-use-current" />
      <Button label="Keep my selection for review" variant="secondary" onPress={() => reconcile(true)} testID="kitchen-policy-keep-draft" />
      <Text style={type.caption}>Neither choice saves settings. Review the selection, then save deliberately.</Text>
    </KitchenPanel> : null}
    <KitchenPanel title="Department managers">
      <Text style={type.body}>Select the existing active staff who act as department managers. The owner and selected managers can review department projects. Staff retain their existing Kitchen access permissions.</Text>
      <Text style={type.caption}>Selected managers approve Production entry and closure. Being the owner or holding a manager role alone does not grant these approvals. Select the owner explicitly if they also serve as a department manager.</Text>
      {workerError ? <Alert tone="error" title="Eligible staff could not be loaded" description="Retry before changing the department managers." action={<Button label="Retry staff list" variant="secondary" onPress={onReload} />} /> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>{choices.map(worker => <KitchenOption key={worker.id} label={worker.full_name} active={ids.includes(worker.id)} disabled={selectionLocked} onPress={() => { if (!submission.busy) setIds(ids.includes(worker.id) ? ids.filter(id => id !== worker.id) : [...ids, worker.id]); }} testID={`kitchen-policy-manager-${worker.id}`} />)}</View>
      {ids.filter(id => !choices.some(worker => worker.id === id)).map(id => <Button key={id} label="Remove unavailable department manager" variant="secondary" onPress={() => setIds(ids.filter(value => value !== id))} disabled={selectionLocked} />)}
      {!ids.length ? <Alert tone="warning" title="No department manager selected" description="Production and closure require an explicitly selected active manager. Existing access grants still apply." /> : null}
      <Button label={adopted ? "Save department managers" : "Adopt resolved policy and department managers"} disabled={selectionLocked} loading={submission.busy} onPress={() => { const body = { decision_contract: KITCHEN_DECISION_CONTRACT, department_manager_user_ids: ids, expected_version: baseVersion }; void submission.submit(body, () => kitchenProjectsApi.configure(body), saved => { setIds(saved.department_manager_user_ids || []); setBaseVersion(saved.version); onSaved(saved); }); }} testID="kitchen-policy-save" />
    </KitchenPanel>
    <Button label={showRules ? "Hide approved operating rules" : "View approved operating rules"} variant="secondary" onPress={() => setShowRules(value => !value)} testID="kitchen-policy-rules-toggle" />
    {showRules ? <View style={{ gap: spacing.lg }}>
    <KitchenPanel title="Identity, customer and CAD rules">
      <Text style={type.body}>A permanent Project ID is assigned when the lead is created and remains unchanged across all stages. Customer name, phone number and address are required to create a lead. Possible duplicates need owner review before conversion; no automatic merge occurs.</Text>
      <Text style={type.body}>CAD must be received, at 100% progress and Completed before Design. Readiness is calculated from these fields.</Text>
    </KitchenPanel>
    <KitchenPanel title="Production and completion rules">
      <Text style={type.body}>Production requires the current shared, customer-approved quotation, matching confirmed order, a positive actual advance received and explicit selected department manager approval. No minimum advance percentage or confirmation document is required.</Text>
      <Text style={type.body}>Installation must be Completed and explicitly approved by a selected department manager before the project appears in Completed.</Text>
    </KitchenPanel>
    <KitchenPanel title="Owner exceptions and preserved history">
      <Text style={type.body}>Only the owner may hold, cancel, reconfirm, reopen or return downstream work to Design. A reason is required. Returning to Design preserves versions, orders, approvals and visits, and requires a fresh design, quotation, order confirmation and manager approvals.</Text>
    </KitchenPanel>
    <KitchenPanel title="Dashboard definitions">
      <Text style={type.body}>Active excludes Completed, Lost, Cancelled and On Hold. On Hold appears separately. Completion overdue uses the target completion date; projects without a target date are never overdue. Dates use India time.</Text>
      <Text style={type.body}>Active order value includes each current, matching confirmed order once on active projects. Drafts, invalidated commercial terms and inactive projects are excluded.</Text>
    </KitchenPanel>
    <KitchenPanel title="Private documents and retention">
      <Text style={type.body}>Allowed formats: PDF, JPG/JPEG, PNG, DOCX and XLSX. Files stay private, are retained, and are shared manually. This tracker does not send customer messages.</Text>
      <Alert tone="warning" title="Current file limit: 25 MB (25,000,000 bytes)" description="Files larger than 768 KiB use bounded private parts; ordinary request limits stay unchanged. Interrupted uploads retain temporary parts for up to 24 hours. Committed private files remain retained." />
    </KitchenPanel>
    </View> : null}
  </View>;
}
