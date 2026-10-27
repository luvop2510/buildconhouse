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
  command: (name: KitchenCommand, payload: Record<string, unknown>, background?: boolean) => Promise<boolean>;
  backgroundSaving: boolean;
  submission: ReturnType<typeof useKitchenSubmission>;
  documentSubmission: ReturnType<typeof useKitchenSubmission>;
  drafts: Record<string, unknown>;
  setDrafts: Dispatch<SetStateAction<Record<string, unknown>>>;
  dirty: boolean;
  currentTaskDirty: boolean;
  resetDraftValue: (key: string) => void;
  isDraftStale: (key: string) => boolean;
  setDraftValue: (key: string, initial: unknown, next: SetStateAction<any>) => void;
};
const Context = createContext<ProjectState | null>(null);
const sameDraft = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function persistedDraftSource(project: KitchenProject | null, key: string): unknown {
  if (!project) return undefined;
  switch (key) {
    case "lead.value": return project.lead;
    case "visit.value": return project.visit;
    case "cad.value": return project.cad;
    case "cad.progress": return String(project.cad.progress);
    case "plan.target": return project.target_completion_date || "";
    default: return undefined;
  }
}

export function kitchenReturnPath(value?: string | string[]) {
  const path = Array.isArray(value) ? value[0] : value;
  return path && /^\/kitchen(?:\/(projects|completed|review|stages\/(lead|visit|cad|design|quotation|order|production|installation|completed)))?(\?[^#]*)?$/.test(path)
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
  const [backgroundSaving, setBackgroundSaving] = useState(false);
  const commandPending = useRef(false);
  const [drafts, publishDrafts] = useState<Record<string, unknown>>({});
  const liveDrafts = useRef(drafts);
  const setDrafts = useCallback<Dispatch<SetStateAction<Record<string, unknown>>>>(next => {
    liveDrafts.current = typeof next === "function" ? next(liveDrafts.current) : next;
    publishDrafts(liveDrafts.current);
  }, []);
  const baselines = useRef<Record<string, unknown>>({});
  const draftSources = useRef<Record<string, unknown>>({});
  const dirty = Object.keys(drafts).some(key => !key.endsWith(".expanded") && key in baselines.current && JSON.stringify(drafts[key]) !== JSON.stringify(baselines.current[key]));
  // Other pages and earlier cycles retain drafts and project exit protection,
  // but only the active task's entries can block its saved-record handoff.
  const taskPrefix = `commercial.cycle.${project?.workflow_cycle ?? 1}.${project?.stage}.`;
  const taskKey = taskPrefix.slice(0, -1);
  const sitePrefix = `commercial.cycle.${project?.workflow_cycle ?? 1}.site.`;
  const currentTaskDirty = Object.keys(drafts).some(key => (key === taskKey || key.startsWith(taskPrefix) || project?.stage === "installation" && key.startsWith(sitePrefix)) && !key.endsWith(".expanded") && key in baselines.current && JSON.stringify(drafts[key]) !== JSON.stringify(baselines.current[key]));
  useKitchenExitGuard({ dirty, scope: `/kitchen/${encodeURIComponent(id)}` });
  const setDraftValue = useCallback((key: string, initial: unknown, next: SetStateAction<any>) => {
    const source = persistedDraftSource(saved.current, key);
    if (!(key in baselines.current)) baselines.current[key] = source !== undefined ? source : initial;
    if (!(key in draftSources.current) && source !== undefined) draftSources.current[key] = source;
    setDrafts(previous => {
      const current = Object.prototype.hasOwnProperty.call(previous, key) ? previous[key] : initial;
      return { ...previous, [key]: typeof next === "function" ? next(current) : next };
    });
  }, [setDrafts]);
  const resetDraftValue = useCallback((key: string) => {
    delete baselines.current[key];
    delete draftSources.current[key];
    setDrafts(previous => { const next = { ...previous }; delete next[key]; return next; });
  }, [setDrafts]);
  const origin = useRef(kitchenReturnPath(returnTo));
  const live = useRef(true);
  const saved = useRef(project);
  saved.current = project;
  const isDraftStale = useCallback((key: string) => key in draftSources.current
    && !sameDraft(draftSources.current[key], persistedDraftSource(saved.current, key)), []);
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
  const command = (name: KitchenCommand, payload: Record<string, unknown>, background = false) => {
    const current = saved.current;
    if (!current || loading || failure || commandPending.current) return Promise.resolve(false);
    // A response/reload can publish before React rerenders the timer that captured this draft.
    if (background && current.version !== project?.version) return Promise.resolve(false);
    // Completing legacy installation may already advance the saved project.
    if (name === "move_stage" && current.stage === payload.target_stage) return Promise.resolve(true);
    // Responses acknowledge only the request snapshot, never entries typed while it was pending.
    const submittedDrafts = { ...liveDrafts.current };
    const submittedBaselines = { ...baselines.current };
    commandPending.current = true;
    setBackgroundSaving(background);
    let accepted = false;
    return submission.submit({ id, command: name, payload }, key => kitchenProjectsApi.command(id, current.version, key, name, payload), value => {
      if (!acceptProject(value)) return;
      accepted = true;
      setRetainedDraft(false);
      const cycle = `commercial.cycle.${current.workflow_cycle ?? 1}`;
      const prefixes: Partial<Record<KitchenCommand, string[]>> = {
        assign: [], edit_lead: ["lead."], save_visit: ["visit."], save_cad: ["cad."], metadata: ["plan."],
        review_duplicate: ["duplicate."],
        design_present: [`${cycle}.design.new.edit`, `${cycle}.design.file`, `${cycle}.design.date`, `${cycle}.design.requirements`, `${cycle}.design.budget`, `${cycle}.design.notes`],
        design_update: [`${cycle}.design.${String(payload.version_id)}.edit`],
        design_share: [`${cycle}.design.${String(payload.version_id)}.shareDate`],
        design_response: [`${cycle}.design.${String(payload.version_id)}.response`, `${cycle}.design.${String(payload.version_id)}.approvalDate`],
        design_revision: [`${cycle}.design.${String(payload.version_id)}.revisionReason`],
        design_handoff: [`${cycle}.design.${String(payload.version_id)}.handoffDate`],
        quotation_update: [`${cycle}.quotation.${String(payload.version_id)}.edit`],
        quotation_receive: [`${cycle}.quotation.new.edit`, `${cycle}.quotation.new.${String(payload.design_version_id)}.edit`, `${cycle}.quotation.date`, `${cycle}.quotation.amount`, `${cycle}.quotation.file`, `${cycle}.quotation.url`, `${cycle}.quotation.notes`],
        quotation_share: [`${cycle}.quotation.${String(payload.version_id)}.shareDate`],
        quotation_response: [`${cycle}.quotation.${String(payload.version_id)}.response`],
        order_confirmation: [`${cycle}.order.confirmed`],
        order_confirm: [`${cycle}.order.finalAmount.`, `${cycle}.order.amountApproved`, `${cycle}.order.confirmed`, `${cycle}.order.date`, `${cycle}.order.file`, `${cycle}.order.notes`],
        order_update: [`${cycle}.order.${current.orders?.at(-1)?.id}.edit`],
        order_document: [`${cycle}.order.file`], order_advance: [`${cycle}.order.advance`], order_amend: [`${cycle}.order.amend`],
        production_update: [`${cycle}.production`], installation_update: [`${cycle}.installation`], site_visit: [`${cycle}.site.`],
        approval: [`${cycle}.${current.stage}.approvalReason`], exception: ["exception."], order_status: ["exception.", `${cycle}.order.status`, `${cycle}.order.statusReason`],
      };
      setDrafts(previous => {
        const updated = { ...previous };
        const same = sameDraft;
        const unchanged = (key: string) => key in submittedDrafts && same(updated[key], submittedDrafts[key]);
        const remove = (key: string) => { delete updated[key]; delete baselines.current[key]; delete draftSources.current[key]; };
        const replaceSaved = (key: string, savedValue: unknown) => {
          if (unchanged(key)) updated[key] = savedValue;
          if (key in submittedDrafts) baselines.current[key] = savedValue;
        };
        if (name === "edit_lead") replaceSaved("lead.value", value.lead);
        if (name === "save_visit") replaceSaved("visit.value", value.visit);
        if (name === "save_cad") {
          replaceSaved("cad.value", value.cad);
          replaceSaved("cad.progress", String(value.cad.progress));
        }
        // Reopening explicitly resets saved installation work, preserving a newer local edit.
        if (name === "exception" && payload.action === "reopen") {
          replaceSaved(`commercial.cycle.${value.workflow_cycle ?? 1}.installation`, value.installation);
        }
        const orderEditorKey = `${cycle}.order.${current.orders?.at(-1)?.id}.edit`;
        const designEditorKey = `${cycle}.design.${String(payload.version_id)}.edit`;
        const quotationEditorKey = `${cycle}.quotation.${String(payload.version_id)}.edit`;
        const editorKey = name === "order_update" ? orderEditorKey : name === "quotation_update" ? quotationEditorKey : designEditorKey;
        if (["order_update", "quotation_update", "design_update"].includes(name) && editorKey in submittedDrafts) {
          if (unchanged(editorKey)) remove(editorKey);
          else {
            const submitted = submittedDrafts[editorKey] as { source: string };
            const edited = updated[editorKey] as { source: string } | undefined;
            const order = value.orders?.find(row => row.id === current.orders?.at(-1)?.id);
            const record = name === "design_update" ? value.design_versions?.find(row => row.id === payload.version_id)
              : name === "quotation_update" ? value.quotation_versions?.find(row => row.id === payload.version_id)
              : order;
            const source = name === "order_update" && order
              ? JSON.stringify([order.order_date, order.notes, order.quotation_version_id])
              : JSON.stringify(record || null);
            // Our own write changes the source identity; rebase only that identity, retaining newer fields.
            if (record && edited?.source === submitted.source) {
              updated[editorKey] = { ...edited, source };
              baselines.current[editorKey] = { ...submitted, source };
            }
          }
        }
        if (name === "order_confirm" && same(updated[orderEditorKey], submittedBaselines[orderEditorKey])) remove(orderEditorKey);
        if (["design_share", "design_response", "design_handoff"].includes(name)
          && same(updated[designEditorKey], submittedBaselines[designEditorKey])) remove(designEditorKey);
        for (const key of Object.keys(updated)) {
          if (!(key in submittedDrafts) || !prefixes[name]?.some(prefix => key.startsWith(prefix))) continue;
          if (["order_update", "quotation_update", "design_update"].includes(name) && key === editorKey) continue;
          if ((name === "design_present" || name === "quotation_receive") && unchanged(key)) { remove(key); continue; }
          // The saved response may normalize ordinary fields; never replace that baseline with newer typing.
          if (!(["edit_lead", "save_visit", "save_cad"].includes(name))) baselines.current[key] = submittedDrafts[key];
          if ((name === "exception" || name === "order_status") && key === "exception.reason") baselines.current[key] = "";
          if (name === "design_revision" && key.endsWith(".revisionReason")) baselines.current[key] = "";
          if (name === "site_visit" && key.startsWith(`${cycle}.site.`)) baselines.current[key] = key.endsWith(".actual") ? "Not recorded" : key.endsWith(".date") ? kitchenToday() : "";
        }
        const acknowledged: Partial<Record<KitchenCommand, string[]>> = {
          edit_lead: ["lead.value"], save_visit: ["visit.value"], save_cad: ["cad.value", "cad.progress"], metadata: ["plan.target"],
        };
        for (const key of acknowledged[name] || []) {
          if (key in submittedDrafts) draftSources.current[key] = persistedDraftSource(value, key);
        }
        return updated;
      });
      if (value.stage !== current.stage) router.replace(kitchenProjectPath(id, `/stages/${value.stage}`, origin.current) as any);
    }).then(result => result && accepted).finally(() => {
      commandPending.current = false;
      if (live.current) setBackgroundSaving(false);
    });
  };
  return <Context.Provider value={{ id, project, loading, failure, policy, policyError,
    returnTo: origin.current, retainedDraft, reload: () => { setRetainedDraft(true); setRetry(value => value + 1); },
    updateProject, command, backgroundSaving, submission, documentSubmission, drafts, setDrafts, dirty, currentTaskDirty, setDraftValue, resetDraftValue, isDraftStale,
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
