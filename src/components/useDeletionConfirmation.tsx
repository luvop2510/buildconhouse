import { useRef, useState } from "react";
import { ConfirmDialog } from "@/src/components/ds";
import { toast } from "@/src/components/Toast";

/** Keep the captured record and confirmation together until the server replies. */
export function useDeletionConfirmation<T>(scope: unknown, testID: string, remove: (target: T) => Promise<boolean>, blocked = false, failure?: string) {
  const scopeIdentity = useRef({ value: scope });
  if (scopeIdentity.current.value !== scope) scopeIdentity.current = { value: scope };
  const identity = scopeIdentity.current;
  type Intent = { scope: typeof identity; target: T; title: string; description?: string };
  const [intent, setIntent] = useState<Intent | null>(null);
  const [pending, setPending] = useState<Intent | null>(null);
  const inProgress = useRef<Intent | null>(null);
  const current = intent?.scope === identity ? intent : null;
  const confirm = async () => {
    if (!current || blocked || inProgress.current) return;
    inProgress.current = current;
    setPending(current);
    try {
      if (await remove(current.target)) setIntent(previous => previous === current ? null : previous);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not confirm deletion. Try again.");
    } finally {
      inProgress.current = null;
      setPending(null);
    }
  };
  return {
    prompt: (target: T, title: string, description?: string) => {
      if (!inProgress.current) setIntent({ scope: identity, target, title, description });
    },
    dialog: <ConfirmDialog visible={!!current} title={current?.title || "Delete this record?"}
      description={blocked && current ? "Waiting for the current save to finish…" : current?.description}
      tone="danger" confirmLabel="Delete" testID={testID} disabled={blocked} loading={!!current && pending === current} error={current ? failure : undefined}
      onConfirm={() => void confirm()} onClose={() => { if (!inProgress.current) setIntent(null); }} />,
  };
}
