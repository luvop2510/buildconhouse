import type { KitchenCreate, KitchenCustomer } from "@/src/api/kitchenProjects";
import { KITCHEN_FLOOR_ID } from "@/src/constants/floors";
import { leadRecoveryStorage } from "./KitchenLeadRecoveryStorage";
export type KitchenLeadRecovery = { version: 1; actorId: string; floorId: string; body: KitchenCreate; customerSnapshot: KitchenCustomer | null; outcome?: "pending" | "rejected" };
const keyFor = (actorId: string) => `forge.kitchen.lead-recovery.v1.${encodeURIComponent(actorId)}.${KITCHEN_FLOOR_ID}`;
// Retain raw operations in order even if the caller's deadline expires. A late
// write must never resurrect an old attempt after its confirmed removal.
const queues = new Map<string, Promise<unknown>>();
function operation<T>(actorId: string, work: (key: string) => Promise<T>): Promise<T> {
  const key = keyFor(actorId);
  const pending = (queues.get(key) || Promise.resolve()).catch(() => undefined).then(() => work(key));
  queues.set(key, pending);
  void pending.finally(() => { if (queues.get(key) === pending) queues.delete(key); }).catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Lead recovery storage did not respond. Your entries are kept; retry when it is available.")), 3000);
    pending.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
export async function readKitchenLeadRecovery(actorId: string): Promise<KitchenLeadRecovery | null> {
  if (!actorId) throw new Error("Sign in before recovering a Kitchen lead");
  const raw = await operation(actorId, key => leadRecoveryStorage.read(key));
  if (raw === null) return null;
  try {
    if (raw.length > 128_000) throw Error();
    const row = JSON.parse(raw);
    const body = row?.body;
    if (row?.version !== 1 || row.actorId !== actorId || row.floorId !== KITCHEN_FLOOR_ID
      || (row.outcome !== undefined && !["pending", "rejected"].includes(row.outcome))
      || !body || typeof body.idempotency_key !== "string" || !/^[A-Za-z0-9:_-]{1,200}$/.test(body.idempotency_key)
      || !body.lead || typeof body.lead !== "object"
      || (body.customer_id ? typeof body.customer_id !== "string" || row.customerSnapshot?.id !== body.customer_id
        || typeof row.customerSnapshot?.name !== "string" || typeof row.customerSnapshot?.phone !== "string"
        : !body.customer || !["name", "phone", "address"].every(field => typeof body.customer[field] === "string"))) throw Error();
    return row;
  } catch { throw new Error("The previous lead recovery entry could not be read. Keep this device's data and contact support before creating another lead."); }
}
export const writeKitchenLeadRecovery = (row: KitchenLeadRecovery) => operation(row.actorId, key => leadRecoveryStorage.write(key, JSON.stringify(row)));
export const removeKitchenLeadRecovery = (actorId: string) => operation(actorId, key => leadRecoveryStorage.remove(key));
