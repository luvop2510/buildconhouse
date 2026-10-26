import { useEffect, useRef, useState } from "react";
import { useKitchenProject } from "./KitchenProjectState";

/** Only callers that exclude consequential changes may enable this hook. */
export function useKitchenAutosave({ draftKey, value, saved, enabled, save }: {
  draftKey: string; value: unknown; saved: unknown; enabled: boolean; save: () => Promise<boolean>;
}) {
  const { drafts, submission } = useKitchenProject();
  const setError = submission.setError;
  const fingerprint = JSON.stringify(value);
  const changed = fingerprint !== JSON.stringify(saved);
  const touched = Object.prototype.hasOwnProperty.call(drafts, draftKey);
  const [result, setResult] = useState<{ key: string; fingerprint: string; failed: boolean } | null>(null);
  const [retryCount, setRetryCount] = useState(0);
  const [saving, setSaving] = useState(false);
  const running = useRef(false);
  const live = useRef(true);
  const latest = useRef({ draftKey, fingerprint, enabled, busy: submission.busy, save });
  latest.current = { draftKey, fingerprint, enabled, busy: submission.busy, save };
  const failed = result?.key === draftKey && result.fingerprint === fingerprint && result.failed;
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (!changed || !touched || !enabled || submission.busy || failed || running.current) return;
    const timer = setTimeout(async () => {
      const current = latest.current;
      if (!live.current || running.current || !current.enabled || current.busy || current.draftKey !== draftKey || current.fingerprint !== fingerprint) return;
      running.current = true; setSaving(true);
      let accepted = false;
      try { accepted = await current.save(); }
      catch { setError("Could not save. Your entries have been kept; retry saving when the connection is available."); }
      finally {
        running.current = false;
        if (live.current) { setSaving(false); setResult({ key: draftKey, fingerprint, failed: !accepted }); }
      }
    }, 700);
    return () => clearTimeout(timer);
  }, [changed, touched, draftKey, fingerprint, enabled, submission.busy, failed, retryCount, saving, setError]);
  // A successful command is not enough: Saved requires the displayed server value.
  const status = !changed ? "saved" : saving ? "saving" : failed ? "failed" : "pending";
  return { status, retry: () => { setResult(null); setRetryCount(count => count + 1); } };
}
