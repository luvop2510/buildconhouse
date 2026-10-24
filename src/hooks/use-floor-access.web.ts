import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "expo-router";

import { api, setRequestFloorId } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { ensureBackendReady } from "@/src/lib/backend-startup";
import { browserStorage } from "@/src/utils/storage/browser.web";

export type Floor = { id: string; name: string; slug: string };
export type FloorAccess = { all_floors: boolean; floors: Floor[]; floor_ids: string[] };

const SELECTED_FLOOR_KEY = "forge.active-floor";
let cache: FloorAccess | null = null;
let inflight: Promise<FloorAccess> | null = null;
let accessGeneration = 0;
let selectedFloorCache: string | null = null;
let selectedFloorRead: Promise<string> | null = null;
let selectedFloorPersistence: Promise<void> = Promise.resolve();
const selectedFloorListeners = new Set<(floorId: string) => void>();

async function loadAccess() {
  if (cache) return cache;
  if (!inflight) {
    const generation = accessGeneration;
    inflight = ensureBackendReady().then(() => {
      if (generation !== accessGeneration) throw Object.assign(new Error("Workspace request cancelled."), { name: "AbortError" });
      return api.get<FloorAccess>("/settings/floor-access", { floorId: "" });
    }).then((value) => {
      // Do not let a request made under the previous staff session restore
      // that session's assignments after logout/login.
      if (generation === accessGeneration) {
        cache = value;
        inflight = null;
      }
      return value;
    }).catch((error) => {
      if (generation === accessGeneration) inflight = null;
      throw error;
    });
  }
  return inflight;
}

/** Clear identity-scoped floor assignments before changing staff sessions. */
export function resetFloorAccess() {
  accessGeneration += 1;
  cache = null;
  inflight = null;
  // Do not let a just-signed-out account's persisted workspace header leak
  // into the next account's first request. Login will choose an assigned
  // floor from the newly authenticated server response.
  selectedFloorCache = "";
  setRequestFloorId("");
}

/** Fetch the current session's assignments so login can select a real floor. */
export function getFloorAccess() {
  return loadAccess();
}

export async function getSelectedFloorId() {
  if (selectedFloorCache !== null) return selectedFloorCache;
  if (!selectedFloorRead) {
    selectedFloorRead = browserStorage.getItem<string>(SELECTED_FLOOR_KEY, "").then((saved) => {
      const resolved = saved || "";
      if (selectedFloorCache === null) selectedFloorCache = resolved;
      setRequestFloorId(selectedFloorCache || "");
      return selectedFloorCache || "";
    }).finally(() => { selectedFloorRead = null; });
  }
  return selectedFloorRead;
}

export function setSelectedFloorId(id: string) {
  selectedFloorCache = id;
  setRequestFloorId(id);
  selectedFloorListeners.forEach((listener) => listener(id));
  selectedFloorPersistence = selectedFloorPersistence.catch(() => undefined)
    .then(async () => { await browserStorage.setItem(SELECTED_FLOOR_KEY, id); });
  return selectedFloorPersistence;
}

export function useFloorAccess(enabled = true) {
  const [access, setAccess] = useState<FloorAccess | null>(cache);
  const [selectedFloorId, setSelectedFloorIdState] = useState(selectedFloorCache || "");
  const [error, setError] = useState<string | null>(null);
  const retry = useCallback(async () => {
    cache = null;
    inflight = null;
    setError(null);
    try {
      await ensureBackendReady({ retry: true });
      const [value, saved] = await Promise.all([loadAccess(), getSelectedFloorId()]);
      setAccess(value);
      const current = selectedFloorCache ?? saved;
      const valid = current && value.floor_ids.includes(current) ? current : value.floors[0]?.id || "";
      setSelectedFloorIdState(valid);
      if (valid !== current) void setSelectedFloorId(valid);
    } catch (cause: any) {
      setAccess(null);
      setError(cause?.detail || "We couldn't load your workspace access.");
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const onSelectedFloorChange = (floorId: string) => { if (alive) setSelectedFloorIdState(floorId); };
    selectedFloorListeners.add(onSelectedFloorChange);
    Promise.all([loadAccess(), getSelectedFloorId()]).then(([value, saved]) => {
      if (!alive) return;
      setAccess(value);
      const fallback = value.floors[0]?.id || "";
      // Another mounted route may already have selected its document floor.
      // A delayed storage snapshot must not overwrite that newer selection.
      const current = selectedFloorCache ?? saved;
      const valid = current && value.floor_ids.includes(current) ? current : fallback;
      setSelectedFloorIdState(valid);
      if (valid !== current) void setSelectedFloorId(valid);
    }).catch((cause: any) => {
      if (!alive) return;
      setAccess(null);
      setError(cause?.detail || "We couldn't load your workspace access.");
    });
    return () => { alive = false; selectedFloorListeners.delete(onSelectedFloorChange); };
  }, [enabled]);
  const selectFloor = useCallback((id: string) => {
    const canSelect = Boolean(access && access.floors.some((floor) => floor.id === id) &&
      (access.all_floors || access.floor_ids.includes(id)));
    return canSelect ? setSelectedFloorId(id) : Promise.resolve();
  }, [access]);
  return { access, floors: access?.floors || [], selectedFloorId, selectFloor, loading: !access && !error, error, retry };
}

export function useRequireFloorAccessState(floorId: string) {
  const { access, selectedFloorId, selectFloor, loading, error, retry } = useFloorAccess();
  const router = useRouter();
  const synchronizedFloorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!access) return;
    if (!(access.all_floors || access.floor_ids.includes(floorId))) {
      toast.error("You don't have access to that floor");
      router.replace("/(admin)/dashboard" as any);
      return;
    }
    // Synchronize deep links once, but never fight a user-initiated floor
    // switch while this route is unmounting.
    if (synchronizedFloorRef.current !== floorId) {
      synchronizedFloorRef.current = floorId;
      if (selectedFloorId !== floorId) void selectFloor(floorId);
    }
  }, [access, floorId, router, selectedFloorId, selectFloor]);
  const ready = Boolean(access && (access.all_floors || access.floor_ids.includes(floorId)) && selectedFloorId === floorId);
  return { ready, loading, error, retry };
}

export function useRequireFloorAccess(floorId: string) {
  return useRequireFloorAccessState(floorId).ready;
}
