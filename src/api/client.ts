// Thin fetch wrapper with token injection.
import { storage } from "@/src/utils/storage";

const SELECTED_FLOOR_KEY = "forge.active-floor";

// Empty string ⇒ same-origin fetch. Kubernetes ingress routes `/api/*` to backend.
const configuredBase = (process.env.EXPO_PUBLIC_BACKEND_URL || "").replace(/\/+$/, "");
const BASE = configuredBase;

// APP_STORE_PLAY_STORE_AUDIT.md Blocker #4: a release build whose
// EXPO_PUBLIC_BACKEND_URL is plain http:// boots to a fully network-dead
// app — iOS App Transport Security silently blocks every request, Android
// blocks cleartext by default on API 28+. That used to fail silently
// (every screen just looks broken); this makes it impossible to miss.
// Native and static production builds must name their HTTPS API explicitly;
// this prevents a deployment from silently reaching a stale hard-coded host.
if (!__DEV__ && !BASE) {
  throw new Error("EXPO_PUBLIC_BACKEND_URL is required in a production build.");
}
if (!__DEV__ && BASE && !BASE.startsWith("https://")) {
  throw new Error(
    `EXPO_PUBLIC_BACKEND_URL must be https:// in a production build (got "${BASE}"). ` +
    "Never work around this with an ATS/cleartext exception — fix the URL in the build profile instead.",
  );
}
const TOKEN_KEY = "forge.jwt";
const TOKEN_KIND_KEY = "forge.jwt.kind"; // "staff" | "customer"
const REQUEST_TIMEOUT_MS = 30_000;
const inflightGets = new Map<string, Promise<unknown>>();
const responseCache = new Map<string, { expiresAt: number; value: unknown }>();
const MAX_RESPONSE_CACHE_ENTRIES = 64;

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

export async function setToken(token: string, kind: TokenKind) {
  invalidateApiRequests();
  tokenCache = token;
  tokenKindCache = kind;
  await storage.secureSet(TOKEN_KEY, token);
  await storage.setItem(TOKEN_KIND_KEY, kind);
}

export async function clearToken() {
  invalidateApiRequests();
  tokenCache = null;
  tokenKindCache = null;
  responseCache.clear();
  await storage.secureRemove(TOKEN_KEY);
  await storage.removeItem(TOKEN_KIND_KEY);
}

export async function getToken(): Promise<string | null> {
  if (tokenCache !== undefined) return tokenCache;
  const stored = (await storage.secureGet<string>(TOKEN_KEY, "")) || null;
  // Login/logout may finish while SecureStore is still reading the old value.
  if (tokenCache === undefined) tokenCache = stored;
  return tokenCache;
}

export async function getTokenKind(): Promise<TokenKind | null> {
  if (tokenKindCache !== undefined) return tokenKindCache;
  const v = await storage.getItem<string>(TOKEN_KIND_KEY, "");
  if (tokenKindCache === undefined) tokenKindCache = (v as TokenKind) || null;
  return tokenKindCache;
}

/** Publish the active floor synchronously so requests never wait on storage. */
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

export function csrfHeaders(): Record<string, string> { return {}; }

async function getRequestFloorId() {
  if (floorCache !== undefined) return floorCache || "";
  const stored = (await storage.getItem<string>(SELECTED_FLOOR_KEY, "")) || "";
  if (floorCache === undefined) floorCache = stored;
  return floorCache;
}

export class ApiError extends Error {
  constructor(public status: number, public detail: string, public payload?: unknown) {
    super(detail);
  }
}

type RequestOptions = { floorId?: string; signal?: AbortSignal; cacheMs?: number };

/** A shared GET owns its transport; each screen only owns its own wait. */
function abortForConsumer<T>(pending: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return pending;
  if (signal.aborted) return Promise.reject(new DOMException("Request cancelled by this screen.", "AbortError"));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new DOMException("Request cancelled by this screen.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function request<T>(method: string, path: string, body?: any, opts?: RequestOptions): Promise<T> {
  const contextVersion = requestContextVersion;
  const identityVersion = identityContextVersion;
  const identityRead = isIdentityRead(method, path);
  const controller = new AbortController();
  activeRequests.set(controller, identityRead);
  const token = await getToken();
  const multipart = typeof FormData !== "undefined" && body instanceof FormData;
  const headers: Record<string, string> = multipart ? {} : { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  // Account restoration must not inherit a stale or newly revoked workspace.
  const floorId = identityRead ? "" : opts?.floorId ?? await getRequestFloorId();
  if (floorId) headers["X-Floor-Id"] = floorId;

  if (identityRead ? identityVersion !== identityContextVersion : contextVersion !== requestContextVersion) {
    activeRequests.delete(controller);
    throw new DOMException("Request cancelled because the signed-in account or workspace changed.", "AbortError");
  }
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  if (opts?.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  try {
    const res = await fetch(`${BASE}/api${path}`, {
      method,
      headers,
      body: multipart ? body as FormData : body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        if (res.ok) throw new ApiError(502, "The server returned an invalid response. Please try again.");
      }
    }
    if (!res.ok) {
      const detail = data && typeof data === "object" && "detail" in data
        ? (data as { detail?: unknown }).detail
        : text || `HTTP ${res.status}`;
      throw new ApiError(res.status, typeof detail === "string" ? detail : JSON.stringify(detail), data);
    }
    if (identityRead ? identityVersion !== identityContextVersion : contextVersion !== requestContextVersion) {
      throw new DOMException("Request cancelled because the signed-in account or workspace changed.", "AbortError");
    }
    return data as T;
  } catch (error) {
    if (timedOut) {
      throw new ApiError(408, "Request timed out. Please try again.");
    }
    // Fetch reports a transport failure as an unhelpful TypeError. Surface a
    // useful, actionable message instead of leaving floor screens looking as
    // though their buttons did nothing when the configured API is offline.
    if (error instanceof TypeError) {
      throw new ApiError(503, "Cannot reach the backend. Check the configured secure backend URL and try again.");
    }
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
  get: <T>(p: string, opts?: RequestOptions) => {
    if (opts?.signal?.aborted) return abortForConsumer(Promise.resolve(undefined as T), opts.signal);
    // Deduplicate concurrent reads across screens/components. This is
    // intentionally in-flight only: dynamic data is never served stale, but
    // StrictMode/remounts and overlapping effects no longer hit the backend
    // twice for the same resource.
    const key = `${opts?.floorId ?? floorCache ?? "auto"}:${p}`;
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
    if (existing) return abortForConsumer(existing as Promise<T>, opts?.signal);
    // Do not pass a consumer's signal to the shared transport. Otherwise one
    // unmount cancels every component waiting for this resource.
    const pending = request<T>("GET", p, undefined, { ...opts, signal: undefined })
      .then((value) => {
        if (cacheVersion === readCacheVersion && opts?.cacheMs && opts.cacheMs > 0) cacheResponse(key, value, opts.cacheMs);
        return value;
      })
      .finally(() => { if (inflightGets.get(key) === pending) inflightGets.delete(key); });
    inflightGets.set(key, pending);
    return abortForConsumer(pending, opts?.signal);
  },
  post: <T>(p: string, b?: any, opts?: RequestOptions) => { return mutate<T>("POST", p, b, opts); },
  put: <T>(p: string, b?: any, opts?: RequestOptions) => { return mutate<T>("PUT", p, b, opts); },
  patch: <T>(p: string, b?: any, opts?: RequestOptions) => { return mutate<T>("PATCH", p, b, opts); },
  delete: <T>(p: string, opts?: RequestOptions) => { return mutate<T>("DELETE", p, undefined, opts); },
  upload: <T>(p: string, form: FormData, opts?: RequestOptions) => mutate<T>("POST", p, form, opts),
  // Build a URL for a browser-download endpoint (PDF/xlsx). Browser
  // navigations can't send an Authorization header, so this mints a
  // short-lived single-use download token via a normal authenticated call
  // first, instead of embedding the real JWT in the URL where it would leak
  // into browser history and server access logs.
  authenticatedUrl: async (path: string, floorId?: string): Promise<string> => {
    const target = `/api${path}`;
    const { token } = await request<{ token: string }>("POST", "/downloads/token", { target }, { floorId });
    const sep = path.includes("?") ? "&" : "?";
    return `${BASE}/api${path}${sep}dl=${encodeURIComponent(token)}`;
  },
  base: BASE,
};
