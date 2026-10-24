import { createBackendStartup } from "./backend-startup-controller";

// Match the web transport: local Expo may use a direct development API;
// production always retains the same-origin authentication proxy.
const base = __DEV__ ? (process.env.EXPO_PUBLIC_BACKEND_URL || "").replace(/\/+$/, "") : "";

const startup = createBackendStartup({
  async probe(timeoutMs) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // Anonymous readiness never reads/revokes a session or carries a floor.
      const response = await fetch(`${base}/api/health/ready`, {
        credentials: "omit", cache: "no-store", signal: controller.signal,
      });
      if (!response.ok) return false;
      const body = await response.json();
      return body?.status === "ok";
    } finally { clearTimeout(timeout); }
  },
});

export const ensureBackendReady = startup.ensureReady;
export const getBackendStartupSnapshot = startup.getSnapshot;
export const subscribeBackendStartup = startup.subscribe;
