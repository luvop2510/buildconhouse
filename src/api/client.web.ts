// Browser implementation of the API client. This is intentionally separate
// from client.ts so web does not retain AsyncStorage/SecureStore in its startup
// dependency graph.
import { browserStorage } from "@/src/utils/storage/browser.web";

const SELECTED_FLOOR_KEY = "forge.active-floor";
const configuredBase = (process.env.EXPO_PUBLIC_BACKEND_URL || "").replace(/\/+$/, "");
// Sites' worker is the web authentication boundary: it turns a successful
// login into an HttpOnly session cookie and forwards that cookie to Railway
// as a Bearer token.  A production browser must therefore always call the
// same-origin `/api` proxy.  Using EXPO_PUBLIC_BACKEND_URL here bypassed the
// worker, so login intentionally discarded the returned token yet subsequent
// requests went straight to Railway unauthenticated.
const BASE = __DEV__ ? configuredBase : "";
// A direct Railway URL is used by local Expo development. In that mode there
// is no same-origin Sites worker to turn the login response into a cookie, so
// retain the bearer token for authenticated API requests. Production web
// builds continue to use the HttpOnly worker session.
const usesDirectDevApi = __DEV__ && Boolean(BASE);
const TOKEN_KIND_KEY = "forge.jwt.kind";
const REQUEST_TIMEOUT_MS = 30_000;
const inflightGets = new Map<string, Promise<unknown>>();
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const activeRequests = new Set<AbortController>();
let tokenCache: string | null | undefined;
let tokenKindCache: TokenKind | null | undefined;
let floorCache: string | null | undefined;
let requestContextVersion = 0;
let readCacheVersion = 0;

export type TokenKind = "staff" | "customer";
export class ApiError extends Error {
  constructor(public status: number, public detail: string, public payload?: unknown) { super(detail); }
}
type RequestOptions = { floorId?: string; signal?: AbortSignal; cacheMs?: number };

/** A shared GET owns its transport; each browser view only owns its own wait. */
function abortForConsumer<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(new DOMException("Request cancelled by this view.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Request cancelled by this view.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function setToken(token: string, kind: TokenKind) {
  invalidateApiRequests();
  // The Sites worker turns a successful web login into an HttpOnly cookie
  // session. Never persist the bearer token returned by the API in browser
  // storage: any future XSS would otherwise be able to exfiltrate it.
  tokenCache = usesDirectDevApi ? token : null;
  tokenKindCache = kind;
  if (usesDirectDevApi) await browserStorage.secureSet("forge.jwt", token);
  await browserStorage.setItem(TOKEN_KIND_KEY, kind);
}
export async function clearToken() {
  invalidateApiRequests();
  tokenCache = null;
  tokenKindCache = null;
  responseCache.clear();
  if (usesDirectDevApi) await browserStorage.secureRemove("forge.jwt");
  await browserStorage.removeItem(TOKEN_KIND_KEY);
}
export async function getToken(): Promise<string | null> {
  if (usesDirectDevApi) {
    if (tokenCache === undefined) tokenCache = (await browserStorage.secureGet<string>("forge.jwt", "")) || null;
    return tokenCache;
  }
  // Production web authentication is cookie-backed.
  if (tokenCache === undefined) tokenCache = null;
  return tokenCache ?? null;
}
export async function getTokenKind(): Promise<TokenKind | null> {
  if (tokenKindCache === undefined) tokenKindCache = ((await browserStorage.getItem<string>(TOKEN_KIND_KEY, "")) as TokenKind) || null;
  return tokenKindCache ?? null;
}
export function setRequestFloorId(floorId: string) {
  // Hydration's first storage read establishes the context; it is not a
  // workspace switch and must not cancel the concurrent floor-access call.
  if (floorCache !== undefined && floorCache !== floorId) invalidateApiRequests();
  floorCache = floorId;
}
export function clearApiResponseCache() {
  readCacheVersion += 1;
  responseCache.clear();
  inflightGets.clear();
}
/** Abort work from the previous identity/workspace before it can update UI. */
export function invalidateApiRequests() {
  requestContextVersion += 1;
  clearApiResponseCache();
  activeRequests.forEach((controller) => controller.abort());
  activeRequests.clear();
}
export function csrfHeaders(): Record<string, string> {
  const csrf = document.cookie.split("; ").find((part) => part.startsWith("forge_csrf="))?.split("=")[1];
  return csrf ? { "X-CSRF-Token": decodeURIComponent(csrf) } : {};
}
async function getRequestFloorId() {
  if (floorCache === undefined) floorCache = (await browserStorage.getItem<string>(SELECTED_FLOOR_KEY, "")) || "";
  return floorCache;
}
async function request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const contextVersion = requestContextVersion;
  const controller = new AbortController();
  activeRequests.add(controller);
  const token = await getToken();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!/^(GET|HEAD|OPTIONS)$/i.test(method)) {
    Object.assign(headers, csrfHeaders());
  }
  const floorId = opts?.floorId ?? await getRequestFloorId();
  if (floorId) headers["X-Floor-Id"] = floorId;
  if (contextVersion !== requestContextVersion) {
    activeRequests.delete(controller);
    throw new DOMException("Request cancelled because the signed-in account or workspace changed.", "AbortError");
  }
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", abortFromCaller, { once: true });
  }
  try {
    const response = await fetch(`${BASE}/api${path}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: controller.signal, credentials: "same-origin",
    });
    const text = await response.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (response.ok) throw new ApiError(502, "The server returned an invalid response. Please try again.");
      }
    }
    if (!response.ok) {
      const detail = data && typeof data === "object" && "detail" in data
        ? (data as { detail?: unknown }).detail
        : text || `HTTP ${response.status}`;
      throw new ApiError(response.status, typeof detail === "string" ? detail : JSON.stringify(detail), data);
    }
    if (contextVersion !== requestContextVersion) {
      throw new DOMException("Request cancelled because the signed-in account or workspace changed.", "AbortError");
    }
    return data as T;
  } catch (error) {
    if (timedOut) throw new ApiError(408, "Request timed out. Please try again.");
    if (error instanceof TypeError) throw new ApiError(503, "Cannot reach the backend. Check the configured secure backend URL and try again.");
    throw error;
  } finally {
    activeRequests.delete(controller);
    clearTimeout(timeoutId);
    opts?.signal?.removeEventListener("abort", abortFromCaller);
  }
}
/** Refreshes after a write must not reuse reads started before it committed. */
async function mutate<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  clearApiResponseCache();
  try { return await request<T>(method, path, body, opts); }
  finally { clearApiResponseCache(); }
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => {
    const key = `${opts?.floorId ?? floorCache ?? "auto"}:${path}`;
    const cacheVersion = readCacheVersion;
    const cached = responseCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return Promise.resolve(cached.value as T);
    if (cached) responseCache.delete(key);
    const existing = inflightGets.get(key);
    if (existing) return abortForConsumer(existing as Promise<T>, opts?.signal);
    // Consumer cancellation must not terminate a request shared by another view.
    const pending = request<T>("GET", path, undefined, { ...opts, signal: undefined }).then((value) => {
      if (cacheVersion === readCacheVersion && opts?.cacheMs && opts.cacheMs > 0) responseCache.set(key, { expiresAt: Date.now() + opts.cacheMs, value });
      return value;
    }).finally(() => { if (inflightGets.get(key) === pending) inflightGets.delete(key); });
    inflightGets.set(key, pending);
    return abortForConsumer(pending, opts?.signal);
  },
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => { return mutate<T>("POST", path, body, opts); },
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => { return mutate<T>("PUT", path, body, opts); },
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => { return mutate<T>("PATCH", path, body, opts); },
  delete: <T>(path: string, opts?: RequestOptions) => { return mutate<T>("DELETE", path, undefined, opts); },
  authenticatedUrl: async (path: string) => {
    const { token } = await request<{ token: string }>("POST", "/downloads/token", { target: `/api${path}` });
    return `${BASE}/api${path}${path.includes("?") ? "&" : "?"}dl=${encodeURIComponent(token)}`;
  },
  base: BASE,
};
