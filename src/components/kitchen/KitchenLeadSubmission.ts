import { useEffect, useRef, useState } from "react";
import { kitchenCreateOutcomeUncertain, kitchenProjectsApi, kitchenRequestKey, type KitchenCreate, type KitchenCustomer, type KitchenProject } from "@/src/api/kitchenProjects";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";
import { readKitchenLeadRecovery, removeKitchenLeadRecovery, writeKitchenLeadRecovery, type KitchenLeadRecovery } from "./KitchenLeadRecovery";
import { errorText } from "./shared";

type LeadDraft = Omit<KitchenCreate, "idempotency_key">;
type Attempt = { fingerprint: string; recovery: KitchenLeadRecovery; uncertain: boolean; confirmed?: KitchenProject };
const fingerprintFor = ({ idempotency_key: _key, ...draft }: KitchenCreate) => JSON.stringify(draft);
/** Persist the original operation before sending any create, including retries. */
export function useKitchenLeadSubmission(actorId: string) {
  const pending = useRef(false);
  const alive = useRef(false);
  const actor = useRef(actorId); actor.current = actorId;
  const attempt = useRef<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [ready, setReady] = useState(false);
  const [restored, setRestored] = useState<KitchenLeadRecovery | null>(null);
  const [recoveryRetry, setRecoveryRetry] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    alive.current = true; setReady(false);
    readKitchenLeadRecovery(actorId).then(row => {
      if (!current || actor.current !== actorId) return;
      attempt.current = row ? { fingerprint: fingerprintFor(row.body), recovery: row, uncertain: row.outcome !== "rejected" } : null;
      setRestored(row); setUncertain(Boolean(attempt.current?.uncertain)); setConfirmed(false); setError(null); setReady(true);
    }).catch(cause => { if (current && actor.current === actorId) { setError(errorText(cause)); setReady(false); } });
    return () => { current = false; alive.current = false; };
  }, [actorId, recoveryRetry]);
  const submit = async (draft: LeadDraft, success: (project: KitchenProject) => void, customerSnapshot: KitchenCustomer | null = null) => {
    if (pending.current || !ready || !actorId) return false;
    const fingerprint = JSON.stringify(draft);
    if ((attempt.current?.uncertain || attempt.current?.confirmed) && fingerprint !== attempt.current.fingerprint) {
      setError("Confirm the previous lead using Retry previous lead before changing these entries."); return false;
    }
    const sameAttempt = attempt.current?.fingerprint === fingerprint;
    if (!sameAttempt) attempt.current = { fingerprint, uncertain: false, recovery: { version: 1, actorId, floorId: KITCHEN_FLOOR_ID,
      body: JSON.parse(JSON.stringify({ ...draft, idempotency_key: kitchenRequestKey() })), customerSnapshot } };
    const current = attempt.current!;
    const isCurrent = () => alive.current && actor.current === actorId;
    pending.current = true; setBusy(true); setError(null);
    try {
      if (!current.confirmed) {
        // Storage failure means no POST. Never call it an uncertain server save.
        await writeKitchenLeadRecovery({ ...current.recovery, outcome: "pending" });
        if (!isCurrent()) return false;
        try { current.confirmed = await kitchenProjectsApi.create(current.recovery.body, current.uncertain); }
        catch (cause) {
          current.uncertain ||= kitchenCreateOutcomeUncertain(cause);
          if (!current.uncertain) await writeKitchenLeadRecovery({ ...current.recovery, outcome: "rejected" });
          throw cause;
        }
      }
      if (!isCurrent()) return false;
      setConfirmed(true); setUncertain(false);
      // Navigation/render callbacks are separate from persistence. If one throws,
      // retain the confirmed result; the next click opens it without another POST.
      try { success(current.confirmed); }
      catch { setError("The lead was saved. Use Open saved lead to continue; no new lead will be created."); return false; }
      try { await removeKitchenLeadRecovery(actorId); }
      catch { /* Its retained operation is safe to reconcile on the next visit. */ }
      if (isCurrent()) { attempt.current = null; setRestored(null); setConfirmed(false); }
      return true;
    } catch (cause) {
      if (isCurrent()) { setUncertain(current.uncertain); setError(`${errorText(cause)} Your entries have been kept.`); }
      return false;
    } finally { pending.current = false; if (isCurrent()) setBusy(false); }
  };
  return { busy, uncertain, confirmed, ready, restored, error, submit, setError, isPending: () => pending.current,
    retryRecovery: () => setRecoveryRetry(value => value + 1),
    reset: () => {
      if (pending.current || attempt.current?.uncertain || attempt.current?.confirmed) return;
      attempt.current = null; setError(null); setRestored(null);
      void removeKitchenLeadRecovery(actorId).catch(cause => { if (alive.current && actor.current === actorId) { setReady(false); setError(errorText(cause)); } });
    },
  };
}
