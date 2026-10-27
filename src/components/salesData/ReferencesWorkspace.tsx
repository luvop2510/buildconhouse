import { useLocalSearchParams } from "expo-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { Text } from "@/src/components/AppText";
import { AdminPage } from "@/src/components/AdminPage";
import { salesWorkspaceApi, type WorkspaceData } from "@/src/api/salesWorkspaces";
import { spacing, type } from "@/src/theme/tokens";
import { FLOOR_LABEL, SalesFilters } from "./SalesFilters";
import { useSalesScope } from "./SalesScope";
import { ReferrerDirectory } from "./ReferrerDirectory";
import { SummaryError, ReportHeader } from "./SalesReportParts";

export function ReferencesWorkspace() {
  const params = useLocalSearchParams<{ kind?: string }>();
  const { floorId, setFloorId, floors, period, choose, accessError, retryAccess } = useSalesScope();
  const [result, setResult] = useState<{ key: string; data?: WorkspaceData; error?: string }>({ key: "" });
  const version = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const key = JSON.stringify([floorId, period?.preset, period?.dateFrom, period?.dateTo]);
  const load = useCallback(() => {
    if (!floorId || !period) return;
    const current = ++version.current;
    controller.current?.abort();
    const request = new AbortController(); controller.current = request;
    setResult({ key });
    void salesWorkspaceApi.get("relationships", { floorId, preset: period.preset, dateFrom: period.dateFrom || undefined, dateTo: period.dateTo || undefined }, { signal: request.signal }).then(
      data => { if (version.current === current) setResult({ key, data }); },
      (cause: unknown) => { if (version.current === current && !request.signal.aborted) setResult({ key, error: typeof (cause as { detail?: unknown })?.detail === "string" ? (cause as { detail: string }).detail : "Reference performance could not load. The contact directory is still available." }); },
    );
  }, [floorId, period, key]);
  useEffect(() => { load(); return () => { version.current += 1; controller.current?.abort(); }; }, [load]);
  const current = result.key === key ? result : null;
  return <AdminPage title="References" header={false} contentStyle={{ gap: spacing.s16, paddingTop: spacing.s16 }}>
    <ReportHeader title="References" subtitle={[FLOOR_LABEL[floorId] || floors.find(floor => floor.id === floorId)?.name || (floorId === "all" ? "All business units" : ""), period?.label].filter(Boolean).join(" · ")} refresh={load} />
    {period ? <SalesFilters floors={floors} floorId={floorId} onFloorChange={setFloorId} period={period} onPeriodChange={choose} /> : null}
    {accessError ? <SummaryError error={accessError} retry={() => void retryAccess()} /> : null}
    {current?.error ? <SummaryError error={current.error} retry={load} /> : null}
    {!current?.data && !current?.error ? <Text style={type.caption}>Loading referral performance…</Text> : null}
    {current?.data?.relationships_truncated ? <Text style={type.bodySm}>Showing performance for up to 2,000 references. The complete contact directory remains searchable.</Text> : null}
    {floorId ? <ReferrerDirectory floorId={floorId} period={period} kind={params.kind === "architect" || params.kind === "interior_designer" ? params.kind : undefined} performance={current?.data?.relationships} onSaved={load} /> : null}
  </AdminPage>;
}
