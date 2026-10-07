// useHistory<T>() — a document-editor-style undo/redo stack for the
// Quotation Builder. One snapshot per meaningful mutation, with optional
// coalescing so a burst of related updates (e.g. typing into an input)
// collapses into a single history entry.
//
// Design goals
//   * Everything the user changes goes through `apply(mut)` — no separate
//     setters — so undo/redo can never miss a mutation.
//   * `coalesceKey` merges adjacent edits with the same key inside a short
//     window (default 800ms). Ideal for text inputs, number steppers,
//     discount sliders.
//   * Bounded stack (default 200 entries) — prevents unbounded memory in
//     long sessions.
//   * `replace(next)` hydrates state without touching the history (used
//     when the initial customer id / recent list resolves).
import { useCallback, useEffect, useState } from "react";

type ApplyOptions = { coalesceKey?: string; skipHistory?: boolean };

export type HistoryApi<T> = {
  state: T;
  apply: (mutator: (s: T) => T, opts?: ApplyOptions) => void;
  replace: (next: T) => void; // hydration, no history entry
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  reset: () => void;
  pastSize: number;
};

export function useHistory<T>(initial: T, opts: { max?: number; coalesceMs?: number } = {}): HistoryApi<T> {
  const max = opts.max ?? 200;
  const coalesceMs = opts.coalesceMs ?? 800;

  const [history, setHistory] = useState(() => ({
    present: initial, past: [] as T[], future: [] as T[],
    coalesce: null as { key: string; ts: number } | null,
  }));

  const apply = useCallback((mutator: (s: T) => T, options?: ApplyOptions) => {
    // Capture the event time once so replay cannot change coalescing decisions.
    const now = Date.now();
    setHistory((previous) => {
      const next = mutator(previous.present);
      if (Object.is(next, previous.present)) return previous;
      if (options?.skipHistory) return { ...previous, present: next, coalesce: null };
      const co = previous.coalesce;
      const shouldCoalesce = !!options?.coalesceKey && !!co &&
        co.key === options.coalesceKey && now - co.ts < coalesceMs;
      const past = shouldCoalesce ? previous.past : previous.past.length >= max
        ? [...previous.past.slice(1), previous.present] : [...previous.past, previous.present];
      return {
        present: next, past, future: [],
        coalesce: options?.coalesceKey ? { key: options.coalesceKey, ts: now } : null,
      };
    });
  }, [max, coalesceMs]);

  const undo = useCallback(() => {
    setHistory((previous) => previous.past.length === 0 ? previous : {
      present: previous.past[previous.past.length - 1],
      past: previous.past.slice(0, -1),
      future: [previous.present, ...previous.future], coalesce: null,
    });
  }, []);

  const redo = useCallback(() => {
    setHistory((previous) => previous.future.length === 0 ? previous : {
      present: previous.future[0],
      past: previous.past.length >= max
        ? [...previous.past.slice(1), previous.present] : [...previous.past, previous.present],
      future: previous.future.slice(1), coalesce: null,
    });
  }, [max]);

  const replace = useCallback((next: T) => {
    // No history entry; used during initial hydration.
    setHistory((previous) => ({ ...previous, present: next, coalesce: null }));
  }, []);

  const reset = useCallback(() => {
    setHistory({ present: initial, past: [], future: [], coalesce: null });
  }, [initial]);

  return {
    state: history.present, apply, replace, undo, redo,
    canUndo: history.past.length > 0, canRedo: history.future.length > 0,
    reset, pastSize: history.past.length,
  };
}

// Web-only keyboard shortcut wiring. Silently no-ops on native.
export function useUndoRedoShortcuts(api: HistoryApi<unknown>, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const target = e.target as HTMLElement | null;
      // If focus is inside a text input, only intercept if user really wants document undo.
      const isTextField = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isTextField && !e.shiftKey && key === "z") return; // let the field handle its own undo
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        api.undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        api.redo();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [api, enabled]);
}
