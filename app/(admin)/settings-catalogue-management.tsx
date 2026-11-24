import { useRouter } from "expo-router";
import { useCallback, useEffect, useMemo, useState } from "react";

import { notifyCatalogueChanged } from "@/src/api/client";
import { catalogueApi, type CatalogueOptions } from "@/src/api/catalogueManagement";
import { CatalogueBrowse } from "@/src/components/catalog/CatalogueBrowse";
import { CatalogueManualForms, catalogueError } from "@/src/components/catalog/CatalogueManualForms";
import { CatalogueWorkbook } from "@/src/components/catalog/CatalogueWorkbook";
import { Dropdown } from "@/src/components/ds";
import { EmptyState, ErrorState, LoadingState } from "@/src/components/ui";
import { SettingsPage } from "@/src/components/settings/SettingsPage";
import { FURNITURE_FLOOR_ID, KITCHEN_FLOOR_ID, SANITARY_FLOOR_ID, TILES_FLOOR_ID } from "@/src/constants/floors";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useAuth } from "@/src/state/auth";

const DEPARTMENTS: Record<string, string> = {
  [TILES_FLOOR_ID]: "Ground Floor — Tiles",
  [SANITARY_FLOOR_ID]: "Sanitary / Bathroom Floor",
  [KITCHEN_FLOOR_ID]: "Kitchen Floor",
  [FURNITURE_FLOOR_ID]: "Furniture Floor",
};

export default function CatalogueManagementScreen() {
  const { staff } = useAuth();
  const router = useRouter();
  const { floors, selectedFloorId, loading, error, retry } = useFloorAccess(Boolean(staff));
  const [selection, setSelection] = useState<{ actor: string; floor: string } | null>(null);
  const allowed = floors.filter(floor => floor.id in DEPARTMENTS && (
    staff?.role === "owner" || staff?.access_grants?.some(grant => grant.floor_id === floor.id && grant.resource.startsWith("catalogue_"))
  ));
  const selected = selection?.actor === staff?.id ? allowed.find(floor => floor.id === selection?.floor) : undefined;
  const department = selected || allowed.find(floor => floor.id === selectedFloorId) || allowed[0];

  return <SettingsPage title="Catalogue Management" back={() => router.replace("/(admin)/settings")}>
    {loading ? <LoadingState label="Checking department access…" /> : null}
    {error ? <ErrorState title="Could not load department access" onRetry={() => void retry()} /> : null}
    {!loading && !error && !department ? <EmptyState icon="lock" title="Catalogue access is required"
      subtitle="Ask the owner to grant Catalogue Management permissions for your department." /> : null}
    {staff && department && selectedFloorId ? <>
      <Dropdown testID="catalogue-department" label={DEPARTMENTS[department.id]} icon="layers"
        items={allowed.map(floor => ({ label: DEPARTMENTS[floor.id], onPress: () => setSelection({ actor: staff.id, floor: floor.id }) }))} />
      <DepartmentCatalogue key={`${staff.id}:${department.id}:${selectedFloorId}`}
        actorId={staff.id} floorId={department.id} activeFloorId={selectedFloorId} />
    </> : null}
  </SettingsPage>;
}

function DepartmentCatalogue({ actorId, floorId, activeFloorId }: { actorId: string; floorId: string; activeFloorId: string }) {
  const [controller, setController] = useState<AbortController | null>(null);
  const [options, setOptions] = useState<CatalogueOptions | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const refresh = useCallback(() => setAttempt(value => value + 1), []);
  const reloadCatalogue = useCallback(() => {
    notifyCatalogueChanged(floorId);
    refresh();
  }, [floorId, refresh]);
  useEffect(() => {
    const lifetime = new AbortController();
    setController(lifetime);
    return () => lifetime.abort();
  }, []);
  const request = useMemo(() => catalogueApi(floorId, activeFloorId, controller?.signal), [floorId, activeFloorId, controller]);

  useEffect(() => {
    if (!controller) return;
    let current = true;
    setError("");
    void request.options().then(value => {
      if (current && !controller.signal.aborted) setOptions(value);
    }).catch(cause => {
      if (current && !controller.signal.aborted) {
        setError(catalogueError(cause, "Could not load this department’s catalogue. Please try again."));
      }
    });
    return () => { current = false; };
  }, [attempt, controller, request]);

  if (error) return <ErrorState title="Catalogue unavailable" subtitle={error} onRetry={refresh} />;
  if (!options || !controller) return <LoadingState label="Loading catalogue options…" />;
  return <>
    <CatalogueManualForms options={options} floorId={floorId} request={request} refresh={reloadCatalogue} signal={controller.signal} />
    <CatalogueBrowse options={options} request={request} revision={attempt} />
    <CatalogueWorkbook options={options} actorId={actorId} floorId={floorId} activeFloorId={activeFloorId}
      request={request} refresh={reloadCatalogue} signal={controller.signal} />
  </>;
}
