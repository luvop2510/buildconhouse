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
type SharedGet = { key: string; promise: Promise<unknown>; controller: AbortController; consumers: number; settled: boolean };
const inflightGets = new Map<string, SharedGet>();
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const MAX_RESPONSE_CACHE_ENTRIES = 64;

// Brief navigation reuse; mutations, floor changes and logout invalidate all entries.
// Editable details and authorization reads stay fresh. Callers can force cacheMs: 0.
function navigationCacheMs(path: string, floorId: string | null | undefined): number {
  if (!floorId) return 0;
  const route = path.split("?")[0];
  if (["/walkins", "/customers", "/followups", "/followups/page", "/followups/inbox",
    "/payments/orders", "/payments/history"].includes(route)) return 2000;
  return floorId === "ground-floor" && ["/tile-orders/customer-orders", "/tile-orders/brands",
    "/tile-orders/history", "/tile-orders/dispatch-list", "/tile-orders/inventory",
    "/tile-orders/material-movements"].includes(route) ? 2000 : 0;
}

function cacheResponse(key: string, value: unknown, ttlMs: number) {
  const now = Date.now();
  // Distinct searches/pages must not retain expired catalog payloads for the
  // whole session. The bounded scan also keeps cleanup independent of URL reuse.
  for (const [cachedKey, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(cachedKey);
  }
  responseCache.delete(key);
  while (responseCache.size >= MAX_RESPONSE_CACHE_ENTRIES) {
    responseCache.delete(responseCache.keys().next().value!);
  }
  responseCache.set(key, { expiresAt: now + ttlMs, value });
}

const activeRequests = new Map<AbortController, boolean>();
let tokenCache: string | null | undefined;
let tokenKindCache: TokenKind | null | undefined;
let floorCache: string | null | undefined;
let requestContextVersion = 0;
let identityContextVersion = 0;
let readCacheVersion = 0;

export type TokenKind = "staff" | "customer";
export class ApiError extends Error {
  constructor(public status: number, public detail: string, public payload?: unknown) { super(detail); }
}
type RequestOptions = { floorId?: string; signal?: AbortSignal; cacheMs?: number };

/** Keep shared reads alive only while at least one consumer still needs them. */
function abortForConsumer<T>(pending: SharedGet, signal?: AbortSignal): Promise<T> {
  pending.consumers += 1;
  return new Promise<T>((resolve, reject) => {
    let finished = false;
    const release = () => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      pending.consumers -= 1;
      if (!pending.settled && pending.consumers === 0) {
        if (inflightGets.get(pending.key) === pending) inflightGets.delete(pending.key);
        pending.controller.abort();
      }
    };
    const abort = () => {
      release();
      reject(new DOMException("Request cancelled by this view.", "AbortError"));
    };
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    pending.promise.then(value => { release(); resolve(value as T); }, error => { release(); reject(error); });
  });
}

export async function setToken(token: string, kind: TokenKind) {
  invalidateApiRequests();
  // The Sites worker turns a successful web login into an HttpOnly cookie
  // session. Never persist the bearer token returned by the API in browser
  // storage: any future XSS would otherwise be able to exfiltrate it.
  tokenCache = usesDirectDevApi ? token : null;
  tokenKindCache = kind;
  // Even direct development keeps credentials only in memory. Remove any
  // token left by earlier builds so persisted secrets cannot survive logout.
  await browserStorage.secureRemove("forge.jwt");
  await browserStorage.setItem(TOKEN_KIND_KEY, kind);
}
export async function clearToken() {
  invalidateApiRequests();
  tokenCache = null;
  tokenKindCache = null;
  responseCache.clear();
  await browserStorage.secureRemove("forge.jwt");
  await browserStorage.removeItem(TOKEN_KIND_KEY);
}
export async function getToken(): Promise<string | null> {
  if (usesDirectDevApi) {
    if (tokenCache === undefined) tokenCache = null;
    return tokenCache ?? null;
  }
  // Production web authentication is cookie-backed.
  if (tokenCache === undefined) tokenCache = null;
  return tokenCache ?? null;
}
export async function getTokenKind(): Promise<TokenKind | null> {
  if (tokenKindCache === undefined) {
    const stored = ((await browserStorage.getItem<string>(TOKEN_KIND_KEY, "")) as TokenKind) || null;
    if (tokenKindCache === undefined) tokenKindCache = stored;
  }
  return tokenKindCache ?? null;
}
export function setRequestFloorId(floorId: string) {
  // Hydration's first storage read establishes the context; it is not a
  // workspace switch and must not cancel the concurrent floor-access call.
  if (floorCache !== undefined && floorCache !== floorId) invalidateApiRequests("workspace");
  floorCache = floorId;
}
export function clearApiResponseCache() {
  readCacheVersion += 1;
  responseCache.clear();
  inflightGets.clear();
}
/** A workspace change preserves account validation; identity changes cancel all work. */
export function invalidateApiRequests(scope: "identity" | "workspace" = "identity") {
  requestContextVersion += 1;
  if (scope === "identity") identityContextVersion += 1;
  clearApiResponseCache();
  activeRequests.forEach((identityRead, controller) => {
    if (scope === "identity" || !identityRead) {
      controller.abort();
      activeRequests.delete(controller);
    }
  });
}

// Only these exact, read-only endpoints hydrate account-wide identity/grants.
// Business reads and every mutation retain workspace cancellation semantics.
function isIdentityRead(method: string, path: string) {
  return method === "GET" && ["/auth/me", "/auth/customer/me", "/settings/access-grants/me"].includes(path);
}

export function csrfHeaders(): Record<string, string> {
  const csrf = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("forge_csrf="))?.slice("forge_csrf=".length);
  // The proxy compares the raw cookie value. Decoding malformed escapes could
  // throw before fetch and prevent even logout or a fresh credential login.
  return csrf ? { "X-CSRF-Token": csrf } : {};
}
export async function getRequestFloorId() {
  if (floorCache === undefined) {
    const stored = (await browserStorage.getItem<string>(SELECTED_FLOOR_KEY, "")) || "";
    if (floorCache === undefined) floorCache = stored;
  }
  return floorCache;
}
async function request<T>(method: string, path: string, body?: unknown, opts?: RequestOptions): Promise<T> {
  const contextVersion = requestContextVersion;
  const identityVersion = identityContextVersion;
  const identityRead = isIdentityRead(method, path);
  const controller = new AbortController();
  activeRequests.set(controller, identityRead);
  const token = await getToken();
  const multipart = typeof FormData !== "undefined" && body instanceof FormData;
  const headers: Record<string, string> = multipart ? {} : { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (!/^(GET|HEAD|OPTIONS)$/i.test(method)) {
    Object.assign(headers, csrfHeaders());
  }
  // Account restoration must not inherit a stale or newly revoked workspace.
  const floorId = identityRead ? "" : opts?.floorId ?? await getRequestFloorId();
  if (floorId) headers["X-Floor-Id"] = floorId;
  if (identityRead ? identityVersion !== identityContextVersion : contextVersion !== requestContextVersion) {
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
    const readTransport = async (retry: boolean): Promise<{ response: Response; text: string }> => {
      try {
        const response = await fetch(`${BASE}/api${path}`, {
          method, headers, body: multipart ? body as FormData : body ? JSON.stringify(body) : undefined,
          signal: controller.signal, credentials: "same-origin",
        });
        return { response, text: await response.text() };
      } catch (error) {
        if (!retry || !(error instanceof TypeError) || controller.signal.aborted) throw error;
        // Recover one dropped Kitchen read within its original deadline. Writes
        // retain their explicit idempotency-key retry instead of being replayed.
        await new Promise<void>((resolve, reject) => {
          const abort = () => { clearTimeout(timer); reject(new DOMException("Request cancelled.", "AbortError")); };
          const timer = setTimeout(() => { controller.signal.removeEventListener("abort", abort); resolve(); }, 150);
          controller.signal.addEventListener("abort", abort, { once: true });
        });
        return readTransport(false);
      }
    };
    const { response, text } = await readTransport(method === "GET" && path.startsWith("/kitchen-projects"));
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
    if (identityRead ? identityVersion !== identityContextVersion : contextVersion !== requestContextVersion) {
      throw new DOMException("Request cancelled because the signed-in account or workspace changed.", "AbortError");
    }
    return data as T;
  } catch (error) {
    if (timedOut) throw new ApiError(408, "Request timed out. Please try again.");
    if (controller.signal.aborted) throw new DOMException("Request cancelled because the signed-in account, workspace or screen changed.", "AbortError");
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
    if (opts?.signal?.aborted) return Promise.reject(new DOMException("Request cancelled by this view.", "AbortError"));
    const key = `${opts?.floorId ?? floorCache ?? "auto"}:${path}`;
    const cacheMs = opts?.cacheMs ?? navigationCacheMs(path, opts?.floorId ?? floorCache);
    const cacheVersion = readCacheVersion;
    const cached = responseCache.get(key);
    if (opts?.cacheMs !== 0 && cached && cached.expiresAt > Date.now()) {
      // Touch the entry so recently visited categories survive eviction.
      responseCache.delete(key);
      responseCache.set(key, cached);
      return Promise.resolve(cached.value as T);
    }
    if (cached) responseCache.delete(key);
    const existing = inflightGets.get(key);
    if (existing) return abortForConsumer<T>(existing, opts?.signal);
    const controller = new AbortController();
    const shared: SharedGet = { key, promise: Promise.resolve(), controller, consumers: 0, settled: false };
    shared.promise = request<T>("GET", path, undefined, { ...opts, signal: controller.signal })
      .then((value) => {
        if (!controller.signal.aborted && cacheVersion === readCacheVersion && cacheMs > 0) cacheResponse(key, value, cacheMs);
        return value;
      })
      .finally(() => {
        shared.settled = true;
        if (inflightGets.get(key) === shared) inflightGets.delete(key);
      });
    inflightGets.set(key, shared);
    return abortForConsumer<T>(shared, opts?.signal);
  },
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => { return mutate<T>("POST", path, body, opts); },
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => { return mutate<T>("PUT", path, body, opts); },
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => { return mutate<T>("PATCH", path, body, opts); },
  delete: <T>(path: string, opts?: RequestOptions) => { return mutate<T>("DELETE", path, undefined, opts); },
  upload: <T>(p: string, form: FormData, opts?: RequestOptions) => mutate<T>("POST", p, form, opts),
  authenticatedUrl: async (path: string, floorId?: string) => {
    const { token } = await request<{ token: string }>("POST", "/downloads/token", { target: `/api${path}` }, { floorId });
    return `${BASE}/api${path}${path.includes("?") ? "&" : "?"}dl=${encodeURIComponent(token)}`;
  },
  base: BASE,
};
