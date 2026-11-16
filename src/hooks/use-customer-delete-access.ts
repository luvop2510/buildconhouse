import { useCallback, useEffect, useState } from "react";
import { useFocusEffect } from "expo-router";
import { AppState } from "react-native";
import { api } from "@/src/api/client";
import { useAuth } from "@/src/state/auth";
import { useFloorAccess } from "@/src/hooks/use-floor-access";

/** Never infer destructive permission from a role rank or cached page access. */
export function useCustomerDeleteAccess(): boolean {
  const { staff } = useAuth();
  const { selectedFloorId } = useFloorAccess();
  const scope = `${staff?.id}:${selectedFloorId}`;
  const [access, setAccess] = useState({ scope: "", allowed: false });
  const refreshOnFocus = useCallback(() => {
    let active = true;
    const controller = new AbortController();
    let generation = 0;
    const load = () => {
      if (!staff || staff.role === "owner") return;
      const current = ++generation;
      void api.get<{ allowed: boolean }>("/settings/permission-matrix/customer-deletion-access", { floorId: selectedFloorId, signal: controller.signal })
        .then(result => { if (active && current === generation) setAccess({ scope, allowed: result.allowed === true }); })
        .catch(() => { if (active && current === generation) setAccess({ scope, allowed: false }); });
    };
    load();
    const interval = setInterval(load, 15000);
    const listener = AppState.addEventListener("change", state => { if (state === "active") load(); });
    return () => { active = false; controller.abort(); clearInterval(interval); listener.remove(); };
  }, [staff, selectedFloorId, scope]);
  useFocusEffect(refreshOnFocus);
  useEffect(() => { if (!staff) setAccess({ scope: "", allowed: false }); }, [staff]);
  return staff?.role === "owner" || access.scope === scope && access.allowed;
}
