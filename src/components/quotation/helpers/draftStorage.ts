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
  queue = queue.catch(() => {}).then(async () => {
    if (expectedEpoch !== epoch) return;
    const key = keyFor(draft.accountId, draft.floorId);
    const raw = await storage.getItem<string>(INDEX, "[]");
    let keys: string[] = [];
    try { keys = JSON.parse(raw || "[]"); } catch { /* replace corrupt index */ }
    if (!Array.isArray(keys)) keys = [];
    await storage.setItem(INDEX, JSON.stringify([...new Set([...keys, key])]));
    if (expectedEpoch === epoch) await storage.setItem(key, JSON.stringify(draft));
  });
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
