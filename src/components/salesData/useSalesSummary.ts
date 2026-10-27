import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { salesSummaryApi, type SalesSummary } from "@/src/api/salesSummary";
import { useSalesScope } from "./SalesScope";

export function useSalesSummary() {
  const { floorId, period } = useSalesScope();
  const key = floorId && period ? JSON.stringify([floorId, period.preset, period.dateFrom, period.dateTo]) : "";
  const [result, setResult] = useState<{ key: string; data: SalesSummary | null; error: string | null; updating: boolean }>({ key: "", data: null, error: null, updating: false });
  const version = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const load = useCallback((fresh = false) => {
    if (!key || !period) return;
    const current = ++version.current;
    controller.current?.abort();
    const request = new AbortController();
    controller.current = request;
    setResult(previous => ({ key, data: previous.key === key ? previous.data : null, error: null, updating: true }));
    void salesSummaryApi.get({ floorId, preset: period.preset, dateFrom: period.dateFrom || undefined, dateTo: period.dateTo || undefined }, { signal: request.signal, fresh }).then(
      data => { if (version.current === current) setResult({ key, data, error: null, updating: false }); },
      (cause: unknown) => {
        if (version.current !== current || request.signal.aborted) return;
        const detail = (cause as { detail?: unknown })?.detail;
        setResult(previous => ({ ...previous, error: typeof detail === "string" ? detail : "Could not load sales data. Try again.", updating: false }));
      },
    );
  }, [key, floorId, period]);
  useFocusEffect(useCallback(() => {
    load();
    return () => { version.current += 1; controller.current?.abort(); };
  }, [load]));
  const active = result.key === key ? result : { data: null, error: null, updating: true };
  return { ...active, refresh: () => load(true) };
}
