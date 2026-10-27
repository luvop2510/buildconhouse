import AsyncStorage from "@react-native-async-storage/async-storage";

import { storage } from "@/src/utils/storage";
import { parseBuilderDraft, type BuilderDraft } from "./draftRecovery";

const PREFIX = "forge.builder.draft.v1";
const INDEX = `${PREFIX}.keys`;
let epoch = 0;
let queue: Promise<unknown> = Promise.resolve();
const keyFor = (accountId: string, floorId: string) => `${PREFIX}.${encodeURIComponent(accountId)}.${encodeURIComponent(floorId)}`;
export const builderDraftEpoch = () => epoch;

export async function readBuilderDraft(accountId: string, floorId: string) {
  const key = keyFor(accountId, floorId);
  const raw = await storage.getItem<string | null>(key, null);
  const draft = parseBuilderDraft(raw, accountId, floorId);
  if (raw && !draft) await storage.removeItem(key);
  return draft;
}

export function writeBuilderDraft(draft: BuilderDraft, expectedEpoch: number) {
  return writeRegisteredBuilderDraft(keyFor(draft.accountId, draft.floorId), draft, expectedEpoch);
}

/** Tile drafts share the registry and revocation queue with sanitary drafts. */
export function writeRegisteredBuilderDraft(key: string, draft: unknown, expectedEpoch: number) {
  queue = queue.catch(() => {}).then(async () => {
    if (expectedEpoch !== epoch) return;
    const raw = await storage.getItem<string>(INDEX, "[]");
    let keys: string[] = [];
    try { keys = JSON.parse(raw || "[]"); } catch { /* replace corrupt index */ }
    if (!Array.isArray(keys)) keys = [];
    if (!await storage.setItem(INDEX, JSON.stringify([...new Set([...keys, key])]))) return false;
    if (expectedEpoch === epoch) return storage.setItem(key, JSON.stringify(draft));
  });
  return queue;
}

export function removeRegisteredBuilderDraft(key: string) {
  queue = queue.catch(() => {}).then(() => storage.removeItem(key));
  return queue;
}

export function removeBuilderDraft(accountId: string, floorId: string) {
  queue = queue.catch(() => {}).then(() => storage.removeItem(keyFor(accountId, floorId)));
  return queue;
}

/** Revocation also invalidates delayed writes from an unmounting builder. */
export async function clearBuilderDrafts() {
  epoch += 1;
  await queue.catch(() => {});
  const raw = await storage.getItem<string>(INDEX, "[]");
  try {
    const keys = JSON.parse(raw || "[]");
    if (Array.isArray(keys)) await Promise.all(keys.filter((key: unknown) => typeof key === "string" && key.startsWith(`${PREFIX}.`)).map((key: string) => storage.removeItem(key)));
  } catch { /* malformed registry */ }
  await storage.removeItem(INDEX);
  await storage.removeItem("forge.builder.snapshot.v4");
}

// This release intentionally clears customer workflows. Remove actual previous
// client draft data before publishing an identity that could restore it. The
// marker preserves quotations created after the reset on subsequent startups.
const RESET_MARKER = "forge.builder.customerResetEpoch.v1";
const CUSTOMER_RESET_EPOCH = "customer-reset-20261010";
let resetMigration: Promise<void> | null = null;

export function ensureBuilderDraftReset(): Promise<void> {
  if (resetMigration) return resetMigration;
  resetMigration = (async () => {
    if (await storage.getItem<string | null>(RESET_MARKER, null) === CUSTOMER_RESET_EPOCH) return;
    epoch += 1;
    await queue.catch(() => {});
    // Enumerate the underlying store as well as removing the old registry:
    // interrupted historical writes can leave a draft without an index entry.
    const keys = await AsyncStorage.getAllKeys();
    const customerKeys = keys.filter((key) => key.startsWith(`${PREFIX}.`) || key === "forge.builder.snapshot.v4");
    const removed = await Promise.all(customerKeys.map((key) => storage.removeItem(key)));
    if (removed.some((ok) => !ok) || !await storage.setItem(RESET_MARKER, CUSTOMER_RESET_EPOCH)) {
      throw new Error("Could not clear previous quotation drafts. Please retry signing in.");
    }
  })().catch((error) => {
    resetMigration = null;
    throw error;
  });
  return resetMigration;
}
