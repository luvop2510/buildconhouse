export type BackendStartupState = {
  phase: "idle" | "checking" | "waking" | "ready" | "unavailable";
};

const WAKE_WINDOW_MS = 60_000;
const PROBE_TIMEOUT_MS = 4_000;
const PROBE_INTERVAL_MS = 1_000;

/** One shared wake attempt. The minute is a retry budget, never a delay. */
export function createBackendStartup({
  probe,
  now = Date.now,
  wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
}: {
  probe: (timeoutMs: number) => Promise<boolean>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}) {
  let state: BackendStartupState = { phase: "idle" };
  let readyUntil = 0;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const publish = (phase: BackendStartupState["phase"]) => {
    if (phase === state.phase) return;
    state = { phase };
    listeners.forEach(listener => listener());
  };
  const unavailable = () => new Error("The backend server has not responded yet. Check your connection and try starting it again.");

  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ensureReady({ retry = false }: { retry?: boolean } = {}): Promise<void> {
      if (pending) return pending;
      if (state.phase === "ready" && now() < readyUntil) return Promise.resolve();
      // Automatic session retries must not start consecutive minute-long loops.
      // Explicit retry, foreground and online events may start a new attempt.
      if (state.phase === "unavailable" && !retry) return Promise.reject(unavailable());
      const deadline = now() + WAKE_WINDOW_MS;
      publish("checking");
      pending = (async () => {
        while (now() < deadline) {
          let ready = false;
          try { ready = await probe(Math.min(PROBE_TIMEOUT_MS, deadline - now())); }
          catch { /* A sleeping server or interrupted network is retryable. */ }
          if (ready && now() <= deadline) {
            readyUntil = now() + WAKE_WINDOW_MS;
            publish("ready");
            return;
          }
          publish("waking");
          const remaining = deadline - now();
          if (remaining > 0) await wait(Math.min(PROBE_INTERVAL_MS, remaining));
        }
        publish("unavailable");
        throw unavailable();
      })().finally(() => { pending = null; });
      return pending;
    },
  };
}
