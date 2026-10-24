import type { BackendStartupState } from "./backend-startup-controller";

// The website's same-origin readiness proxy is web-only. Native transports keep
// their existing secure API/session behavior.
const idle: BackendStartupState = { phase: "idle" };
export const getBackendStartupSnapshot = () => idle;
export const subscribeBackendStartup = (_listener: () => void) => () => {};
export const ensureBackendReady = (_options: { retry?: boolean } = {}): Promise<void> => Promise.resolve();
