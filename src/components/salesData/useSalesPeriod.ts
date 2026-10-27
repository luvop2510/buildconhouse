import { useCallback, useEffect, useRef, useState } from "react";

import { salesDataApi, type DefaultPeriod } from "@/src/api/salesData";
import { customDateRange, inclusiveEndDay, rangeLabel } from "./periodDates";
import { storage } from "@/src/utils/storage";

/** Presets the backend's `periods.resolve` genuinely understands. Offering
 *  one it does not would silently fall through to its "all time" branch and
 *  quietly show the whole book under a label promising a narrow window. */
export const PERIOD_PRESETS = [
  { value: "today", label: "Today" },
  { value: "this_month", label: "This month" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_month", label: "Last month" },
  { value: "quarter", label: "This quarter" },
  { value: "year", label: "This year" },
  { value: "all", label: "All time" },
] as const;

export type SelectedPeriod = {
  preset: string;
  dateFrom: string | null;
  dateTo: string | null;
  /** Human label for the range currently in force. */
  label: string;
};

/** Why the page is showing the period it is showing. */
export type PeriodOrigin = "loading" | "default" | "fallback" | "restored" | "chosen";

const STORAGE_KEY = "forge.sales-data.period";

function labelFor(preset: string) {
  return PERIOD_PRESETS.find((p) => p.value === preset)?.label || "Custom range";
}

async function readSaved(): Promise<SelectedPeriod | null> {
  // storage only persists primitives, so the selection round-trips as JSON.
  const raw = await storage.getItem<string>(STORAGE_KEY, "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.preset === "custom" && typeof parsed.dateFrom === "string" && typeof parsed.dateTo === "string") {
      const range = customDateRange(parsed.dateFrom.slice(0, 10), inclusiveEndDay(parsed.dateTo));
      if (range) return { preset: "custom", ...range, label: rangeLabel(range.dateFrom, range.dateTo) };
    }
    if (PERIOD_PRESETS.some((p) => p.value === parsed?.preset)) {
      return { preset: parsed.preset, dateFrom: null, dateTo: null, label: labelFor(parsed.preset) };
    }
  } catch {
    // A corrupted entry must not brick the page — fall through to the
    // server-resolved default and let the next selection overwrite it.
  }
  return null;
}

function periodOf(server: DefaultPeriod): SelectedPeriod {
  return {
    preset: server.preset,
    dateFrom: server.date_from,
    dateTo: server.date_to,
    label: server.label,
  };
}

/**
 * The period Sales Data opens on, and the memory of what the owner last chose.
 *
 * Resolution order, deliberately:
 *   1. A previously chosen period, restored from storage — "open exactly
 *      where they left off".
 *   2. The server's smart default: "this month" when it has orders in it,
 *      otherwise the calendar month of the most recent confirmed order.
 *
 * The smart default is resolved by the backend, not here, because only the
 * database knows whether the current month is empty, and the answer is
 * floor-dependent: a unit that booked nothing this month should fall back
 * even when the other unit did not.
 *
 * `serverDefault` is fetched on every visit even when a saved period wins,
 * because it carries `latest_order_at` — the anchor the page needs to offer
 * a way out of an empty view. A restored or explicitly chosen period is
 * never silently overridden (that would be the page arguing with the owner);
 * instead the page surfaces a one-tap jump to the period that does have
 * data. That is what keeps "never open onto an empty dashboard" true without
 * making a deliberate selection unstick itself.
 */
export function useSalesPeriod(floorId: string, catalogFallback = true) {
  const [period, setPeriod] = useState<SelectedPeriod | null>(null);
  const [origin, setOrigin] = useState<PeriodOrigin>("loading");
  const [serverDefault, setServerDefault] = useState<DefaultPeriod | null>(null);

  const selectionVersion = useRef(0);

  useEffect(() => {
    if (!floorId) return; // floor not resolved yet — never query unscoped
    let alive = true;
    const controller = new AbortController();
    const version = selectionVersion.current;
    setServerDefault(null);

    (async () => {
      const [saved, server] = await Promise.all([
        readSaved(),
        // The legacy probe only knows catalog orders. Multi-source reports use
        // the calendar month, so an older tile order cannot hide new project sales.
        catalogFallback ? salesDataApi.defaultPeriod(floorId, { signal: controller.signal }).catch(() => null) : Promise.resolve(null),
      ]);
      if (!alive) return;

      setServerDefault(server);
      if (version !== selectionVersion.current) return;

      if (saved) {
        setPeriod(saved);
        setOrigin("restored");
        return;
      }
      if (server) {
        setPeriod(periodOf(server));
        setOrigin(server.fallback_applied ? "fallback" : "default");
        return;
      }
      // The probe failed and nothing was saved. The plain calendar month is
      // a correct — if possibly empty — answer, and beats a blank screen.
      setPeriod({ preset: "this_month", dateFrom: null, dateTo: null, label: "This month" });
      setOrigin("default");
    })();

    return () => { alive = false; controller.abort(); };
  }, [floorId, catalogFallback]);

  const choose = useCallback((next: { preset: string; dateFrom?: string | null; dateTo?: string | null }) => {
    selectionVersion.current += 1;
    const chosen: SelectedPeriod = {
      preset: next.preset,
      dateFrom: next.dateFrom ?? null,
      dateTo: next.dateTo ?? null,
      label: next.preset === "custom" ? rangeLabel(next.dateFrom ?? null, next.dateTo ?? null) : labelFor(next.preset),
    };
    setPeriod(chosen);
    setOrigin("chosen");
    void storage.setItem(STORAGE_KEY, JSON.stringify(chosen));
  }, []);

  /** Jump to the period the server says actually holds the most recent
   *  orders. Offered from the empty-state banner, never applied silently. */
  const jumpToLatest = useCallback(() => {
    if (!serverDefault) return;
    choose({
      preset: serverDefault.preset,
      dateFrom: serverDefault.date_from,
      dateTo: serverDefault.date_to,
    });
    // `choose` labels a custom preset generically; the server knows the real
    // one ("July 2026"), which is far more useful on the filter row.
    setPeriod({ ...periodOf(serverDefault) });
    void storage.setItem(STORAGE_KEY, JSON.stringify(periodOf(serverDefault)));
  }, [serverDefault, choose]);

  return { period, origin, serverDefault, choose, jumpToLatest };
}
