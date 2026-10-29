import { createContext, useContext, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useFloorAccess } from "@/src/hooks/use-floor-access";
import { useActionAccess } from "@/src/hooks/use-permissions";
import { useAuth } from "@/src/state/auth";
import { storage } from "@/src/utils/storage";
import { useSalesPeriod } from "./useSalesPeriod";

function useScope() {
  const { staff } = useAuth();
  const canView = useActionAccess("sales_data", "view", staff?.role === "owner");
  const { floors, selectedFloorId, error, retry } = useFloorAccess(!!staff && canView);
  const [reportFloor, setReportFloor] = useState<string | null>(null);
  const previousFloor = useRef("");
  const selectionVersion = useRef(0);
  const storageKey = `forge.sales-data.floor.${staff?.id || ""}`;
  useEffect(() => {
    if (!staff?.id || !selectedFloorId || !floors.length) return;
    let alive = true;
    if (previousFloor.current && previousFloor.current !== selectedFloorId) {
      setReportFloor(null);
      void storage.setItem(storageKey, "");
    } else if (!previousFloor.current) {
      const version = selectionVersion.current;
      void storage.getItem<string>(storageKey, "").then(saved => {
        if (alive && version === selectionVersion.current && (saved === "all" || floors.some(floor => floor.id === saved))) setReportFloor(saved);
      });
    }
    previousFloor.current = selectedFloorId;
    return () => { alive = false; };
  }, [selectedFloorId, floors, staff?.id, storageKey]);
  const setFloorId = useCallback((id: string) => {
    if (id !== "all" && !floors.some(floor => floor.id === id)) return;
    selectionVersion.current += 1;
    setReportFloor(id);
    void storage.setItem(storageKey, id);
  }, [floors, storageKey]);
  const floorId = canView && selectedFloorId ? reportFloor ?? selectedFloorId : "";
  const period = useSalesPeriod(floorId, false);
  return { ...period, floorId, setFloorId, floors, canView, accessError: error, retryAccess: retry };
}
const SalesScope = createContext<ReturnType<typeof useScope> | null>(null);
/** Keep the report scope when moving between sales, references and customers. */
export function SalesScopeProvider({ children }: { children: ReactNode }) {
  const scope = useScope();
  return <SalesScope.Provider value={scope}>{children}</SalesScope.Provider>;
}
export function useSalesScope() {
  const scope = useContext(SalesScope);
  if (!scope) throw new Error("Sales reports require SalesScopeProvider");
  return scope;
}
