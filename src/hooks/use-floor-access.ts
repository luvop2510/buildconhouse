import { useCallback, useEffect, useRef, useState } from "react";

import { useRouter } from "expo-router";

import { api, setRequestFloorId } from "@/src/api/client";
import { toast } from "@/src/components/Toast";
import { storage } from "@/src/utils/storage";

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
    inflight = api.get<FloorAccess>("/settings/floor-access", { floorId: "" }).then((value) => {
      // A previous user's request can resolve after sign-out/sign-in. Do not
      // repopulate the shared cache with that user's floor assignments.
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
    selectedFloorRead = storage.getItem<string>(SELECTED_FLOOR_KEY, "").then((saved) => {
      // A floor can be selected while storage is still being read (for
      // example immediately after login). Never let that older read win over
      // the already-published in-memory selection.
      if (selectedFloorCache === null) selectedFloorCache = saved || "";
      setRequestFloorId(selectedFloorCache);
      return selectedFloorCache;
    }).finally(() => {
      selectedFloorRead = null;
    });
  }
  return selectedFloorRead;
}

export function setSelectedFloorId(id: string) {
  selectedFloorCache = id;
  setRequestFloorId(id);
  selectedFloorListeners.forEach((listener) => listener(id));

  // Publish first for instant UI updates, then serialize writes so a fast
  // sequence of floor changes cannot finish out of order in storage.
  selectedFloorPersistence = selectedFloorPersistence
    .catch(() => undefined)
    .then(async () => { await storage.setItem(SELECTED_FLOOR_KEY, id); });
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
    const onSelectedFloorChange = (floorId: string) => {
      if (alive) setSelectedFloorIdState(floorId);
    };
    selectedFloorListeners.add(onSelectedFloorChange);
    Promise.all([loadAccess(), getSelectedFloorId()]).then(([value, saved]) => {
      if (!alive) return;
      setAccess(value);
      // Everyone — including all-floor owners/managers — always has exactly
      // one concrete floor active. The old unscoped ("") default sent no
      // X-Floor-Id header, so every scoped query ran unfiltered and mixed
      // both business units' records together. A saved choice wins if it is
      // still a floor this account can access.
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
    return () => {
      alive = false;
      selectedFloorListeners.delete(onSelectedFloorChange);
    };
  }, [enabled]);

  const selectFloor = useCallback((id: string) => {
    // Only a real, accessible floor can become active — never "" (see the
    // unscoped-default note above).
    const canSelect = Boolean(
      access && access.floors.some((floor) => floor.id === id) &&
      (access.all_floors || access.floor_ids.includes(id)),
    );
    if (!canSelect) return Promise.resolve();
    return setSelectedFloorId(id);
  }, [access]);

  return { access, floors: access?.floors || [], selectedFloorId, selectFloor, loading: !access && !error, error, retry };
}

/** Gate a floor-specific screen, and make that floor the active one.
 *
 * Persisting the active floor matters as much as the access check: a
 * screen reached by direct URL, refresh or bookmark never went through the
 * sidebar link that switches floors, so the sticky selection could still
 * point at another business unit while its records were being written
 * (that is how tile documents ended up stamped `first-floor`). */
export function useRequireFloorAccessState(floorId: string) {
  const { access, selectedFloorId, selectFloor, loading, error, retry } = useFloorAccess();
  const router = useRouter();
  const synchronizedFloorRef = useRef<string | null>(null);
  useEffect(() => {
    if (!access) return; // still loading — nothing to enforce yet
    const allowed = access.all_floors || access.floor_ids.includes(floorId);
    if (!allowed) {
      toast.error("You don't have access to that floor");
      router.replace("/(admin)/dashboard" as any);
      return;
    }
    // A floor-pinned URL sets the workspace once when it mounts (bookmarks
    // and direct links need this). It must not keep forcing that floor after
    // the user has selected another workspace: while the router is replacing
    // this screen, that feedback loop used to undo the switch and cancel the
    // new floor's requests.
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
