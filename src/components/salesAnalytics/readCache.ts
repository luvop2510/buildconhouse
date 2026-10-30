type Identity = {
 id: string; role: string; active?: boolean; floor_ids?: string[];
 custom_access?: boolean; access_profile?: unknown; access_grants?: unknown;
};

/** Scope the preview to every permission input, not only a person's ID. */
export function analyticsIdentityKey(staff: Identity | null) {
 return JSON.stringify(staff ? [staff.id, staff.role, staff.active, [...(staff.floor_ids || [])].sort(),
  staff.custom_access, staff.access_profile, staff.access_grants] : null);
}

const entries = new Map<string, { data: unknown; expiresAt: number }>();
const MAX_ENTRIES = 24;
const FRESH_MS = 30_000;
let generation = 0;

export const analyticsCacheGeneration = () => generation;
export function clearAnalyticsReadCache() { generation += 1; entries.clear(); }
const revocationListeners = new Set<() => void>();
export function subscribeAnalyticsRevocation(listener: () => void) {
 revocationListeners.add(listener); return () => { revocationListeners.delete(listener); };
}
/** Denial invalidates every preview and pending response, including other mounted pages. */
export function revokeAnalyticsReads() {
 clearAnalyticsReadCache(); revocationListeners.forEach(listener => listener());
}
export function cachedAnalyticsRead<T>(key: string): T | null {
 const entry = entries.get(key);
 if (!entry) return null;
 if (entry.expiresAt <= Date.now()) { entries.delete(key); return null; }
 entries.delete(key); entries.set(key, entry);
 return entry.data as T;
}
export function cacheAnalyticsRead<T>(key: string, data: T, expectedGeneration: number) {
 if (generation !== expectedGeneration) return;
 const now = Date.now();
 for (const [cachedKey, entry] of entries) if (entry.expiresAt <= now) entries.delete(cachedKey);
 entries.delete(key);
 while (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
 entries.set(key, { data, expiresAt: now + FRESH_MS });
}
