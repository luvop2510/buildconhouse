import { createContext, useCallback, useContext, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { useRouter } from "expo-router";
import { KITCHEN_STAGES, kitchenProjectsApi, type KitchenCommand, type KitchenPolicy, type KitchenProject } from "@/src/api/kitchenProjects";
import { errorText, useKitchenSubmission } from "./shared";
import { kitchenToday } from "./KitchenDates";
import { useKitchenExitGuard } from "./KitchenExitGuard";

type ProjectState = {
  id: string;
  project: KitchenProject | null;
  loading: boolean;
  failure: string | null;
  policy: KitchenPolicy | null;
  policyError: boolean;
  returnTo: string;
  retainedDraft: boolean;
  reload: () => void;
  updateProject: (project: KitchenProject) => void;
  command: (name: KitchenCommand, payload: Record<string, unknown>) => Promise<boolean>;
  submission: ReturnType<typeof useKitchenSubmission>;
  documentSubmission: ReturnType<typeof useKitchenSubmission>;
  drafts: Record<string, unknown>;
  setDrafts: Dispatch<SetStateAction<Record<string, unknown>>>;
  dirty: boolean;
  currentTaskDirty: boolean;
  resetDraftValue: (key: string) => void;
  setDraftValue: (key: string, initial: unknown, next: SetStateAction<any>) => void;
};
const Context = createContext<ProjectState | null>(null);

export function kitchenReturnPath(value?: string | string[]) {
  const path = Array.isArray(value) ? value[0] : value;
  return path && /^\/kitchen\/(projects|completed|review|stages\/(lead|visit|cad|design|quotation|order|production|installation|completed))(\?[^#]*)?$/.test(path)
    ? path : "/kitchen/stages/lead";
}

export function kitchenProjectPath(id: string, suffix = "", returnTo = "/kitchen/stages/lead") {
  return `/(admin)/kitchen/${encodeURIComponent(id)}${suffix}?returnTo=${encodeURIComponent(kitchenReturnPath(returnTo))}`;
}

/** This ancestor remains mounted while project sibling routes change. */
export function KitchenProjectProvider({ id, returnTo, children }: { id: string; returnTo?: string | string[]; children: ReactNode }) {
  const router = useRouter();
  const [project, setProject] = useState<KitchenProject | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [policy, setPolicy] = useState<KitchenPolicy | null>(null);
  const [policyError, setPolicyError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [retainedDraft, setRetainedDraft] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, unknown>>({});
  const baselines = useRef<Record<string, unknown>>({});
  const dirty = Object.keys(drafts).some(key => !key.endsWith(".expanded") && key in baselines.current && JSON.stringify(drafts[key]) !== JSON.stringify(baselines.current[key]));
  // Other pages and earlier cycles retain drafts and project exit protection,
  // but only the active task's entries can block its saved-record handoff.
  const taskPrefix = `commercial.cycle.${project?.workflow_cycle ?? 1}.${project?.stage}.`;
  const taskKey = taskPrefix.slice(0, -1);
  const sitePrefix = `commercial.cycle.${project?.workflow_cycle ?? 1}.site.`;
  const currentTaskDirty = Object.keys(drafts).some(key => (key === taskKey || key.startsWith(taskPrefix) || project?.stage === "installation" && key.startsWith(sitePrefix)) && !key.endsWith(".expanded") && key in baselines.current && JSON.stringify(drafts[key]) !== JSON.stringify(baselines.current[key]));
  useKitchenExitGuard({ dirty, scope: `/kitchen/${encodeURIComponent(id)}` });
  const setDraftValue = useCallback((key: string, initial: unknown, next: SetStateAction<any>) => {
    if (!(key in baselines.current)) baselines.current[key] = initial;
    setDrafts(previous => {
      const current = Object.prototype.hasOwnProperty.call(previous, key) ? previous[key] : initial;
      return { ...previous, [key]: typeof next === "function" ? next(current) : next };
    });
  }, []);
  const resetDraftValue = useCallback((key: string) => {
    delete baselines.current[key];
    setDrafts(previous => { const next = { ...previous }; delete next[key]; return next; });
  }, []);
  const origin = useRef(kitchenReturnPath(returnTo));
  const live = useRef(true);
  const saved = useRef(project);
  saved.current = project;
  const submission = useKitchenSubmission();
  const documentSubmission = useKitchenSubmission();
  const acceptProject = useCallback((value: KitchenProject) => {
    if (!live.current || value.id !== id || saved.current && value.version < saved.current.version) return false;
    saved.current = value;
    setProject(value);
    return true;
  }, [id]);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setFailure(null);
    kitchenProjectsApi.get(id, controller.signal)
      .then(value => { if (!controller.signal.aborted) acceptProject(value); })
      .catch(error => { if (!controller.signal.aborted) setFailure(error?.status === 403 ? "You do not have permission to view this Kitchen project." : errorText(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    kitchenProjectsApi.configuration(controller.signal)
      .then(value => { if (!controller.signal.aborted) { setPolicy(value); setPolicyError(false); } })
      .catch(() => { if (!controller.signal.aborted) setPolicyError(true); });
    return () => controller.abort();
  }, [id, retry, acceptProject]);
  const updateProject = acceptProject;
  const command = (name: KitchenCommand, payload: Record<string, unknown>) => {
    const current = saved.current;
    if (!current || loading || failure) return Promise.resolve(false);
    // Completing legacy installation may already advance the saved project.
    if (name === "move_stage" && current.stage === payload.target_stage) return Promise.resolve(true);
    return submission.submit({ id, command: name, payload }, key => kitchenProjectsApi.command(id, current.version, key, name, payload), value => {
      if (!acceptProject(value)) return;
      setRetainedDraft(false);
      const cycle = `commercial.cycle.${current.workflow_cycle ?? 1}`;
      const prefixes: Partial<Record<KitchenCommand, string[]>> = {
        assign: [], edit_lead: ["lead."], save_visit: ["visit."], save_cad: ["cad."], metadata: ["plan."],
        review_duplicate: ["duplicate."],
        design_present: [`${cycle}.design.file`, `${cycle}.design.date`, `${cycle}.design.requirements`, `${cycle}.design.budget`, `${cycle}.design.notes`],
        design_update: [`${cycle}.design.${String(payload.version_id)}.edit`],
        design_share: [`${cycle}.design.${String(payload.version_id)}.shareDate`],
        design_response: [`${cycle}.design.${String(payload.version_id)}.response`],
        design_revision: [`${cycle}.design.${String(payload.version_id)}.revisionReason`],
        design_handoff: [`${cycle}.design.${String(payload.version_id)}.handoffDate`],
        quotation_receive: [`${cycle}.quotation.date`, `${cycle}.quotation.amount`, `${cycle}.quotation.file`, `${cycle}.quotation.url`, `${cycle}.quotation.notes`],
        quotation_share: [`${cycle}.quotation.${String(payload.version_id)}.shareDate`],
        quotation_response: [`${cycle}.quotation.${String(payload.version_id)}.response`],
        order_confirm: [`${cycle}.order.finalAmount.`, `${cycle}.order.amountApproved`, `${cycle}.order.confirmed`, `${cycle}.order.date`, `${cycle}.order.file`, `${cycle}.order.notes`],
        order_update: [`${cycle}.order.${current.orders?.at(-1)?.id}.edit`],
        order_document: [`${cycle}.order.file`], order_advance: [`${cycle}.order.advance`], order_amend: [`${cycle}.order.amend`],
        production_update: [`${cycle}.production`], installation_update: [`${cycle}.installation`], site_visit: [`${cycle}.site.`],
        approval: [`${cycle}.${current.stage}.approvalReason`], exception: ["exception."], order_status: ["exception."],
      };
      setDrafts(previous => {
        const updated: Record<string, unknown> = { ...previous,
        ...(name === "edit_lead" ? { "lead.value": value.lead } : {}),
        ...(name === "save_visit" ? { "visit.value": value.visit } : {}),
        ...(name === "save_cad" ? { "cad.value": value.cad, "cad.progress": String(value.cad.progress) } : {}),
        // Reopening keeps the workflow cycle but resets saved installation work.
        // Replace its completed draft before the task route mounts again.
        ...(name === "exception" && payload.action === "reopen"
          ? { [`commercial.cycle.${value.workflow_cycle ?? 1}.installation`]: value.installation }
          : {}),
        };
        const orderEditorKey = `${cycle}.order.${current.orders?.at(-1)?.id}.edit`;
        if (name === "order_update" || JSON.stringify(updated[orderEditorKey]) === JSON.stringify(baselines.current[orderEditorKey]) && name === "order_confirm") {
          delete updated[orderEditorKey];
          delete baselines.current[orderEditorKey];
        }
        const editorKey = `${cycle}.design.${String(payload.version_id)}.edit`;
        if (name === "design_update" || ["design_share", "design_response", "design_handoff"].includes(name)
          && JSON.stringify(updated[editorKey]) === JSON.stringify(baselines.current[editorKey])) {
          delete updated[editorKey];
          delete baselines.current[editorKey];
        }
        for (const key of Object.keys(updated)) {
          if ((name === "design_present" || name === "quotation_receive") && prefixes[name]?.includes(key)) {
            delete updated[key];
            delete baselines.current[key];
            continue;
          }
          if (prefixes[name]?.some(prefix => key.startsWith(prefix))) baselines.current[key] = updated[key];
          if ((name === "exception" || name === "order_status") && key === "exception.reason") baselines.current[key] = "";
          if (name === "design_revision" && key.endsWith(".revisionReason")) baselines.current[key] = "";
          if (name === "site_visit" && key.startsWith(`${cycle}.site.`)) baselines.current[key] = key.endsWith(".actual") ? "Not recorded" : key.endsWith(".date") ? kitchenToday() : "";
        }
        return updated;
      });
      if (value.stage !== current.stage) router.replace(kitchenProjectPath(id, `/stages/${value.stage}`, origin.current) as any);
    });
  };
  return <Context.Provider value={{ id, project, loading, failure, policy, policyError,
    returnTo: origin.current, retainedDraft, reload: () => { setRetainedDraft(true); setRetry(value => value + 1); },
    updateProject, command, submission, documentSubmission, drafts, setDrafts, dirty, currentTaskDirty, setDraftValue, resetDraftValue,
  }}>{children}</Context.Provider>;
}

export function useKitchenProject() {
  const value = useContext(Context);
  if (!value) throw new Error("Kitchen project pages require their project layout");
  return value;
}

/** Memory-only drafts are scoped to this project, never another customer. */
export function useKitchenDraft<T,>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const { drafts, setDraftValue } = useKitchenProject();
  const baseline = useRef(initial);
  baseline.current = initial;
  const value = Object.prototype.hasOwnProperty.call(drafts, key) ? drafts[key] as T : initial;
  const setValue = useCallback<Dispatch<SetStateAction<T>>>(next => {
    setDraftValue(key, baseline.current, next);
  }, [key, setDraftValue]);
  return [value, setValue];
}

export function kitchenStage(value?: string | string[]) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return KITCHEN_STAGES.find(stage => stage === candidate);
}
