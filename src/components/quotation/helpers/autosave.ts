/**
 * Shared quotation persistence primitive.
 *
 * Both quotation presentations may schedule a save while an earlier request
 * is still in flight. Keeping the queue here makes the ordering guarantee a
 * property of the quotation system rather than of one particular builder.
 */
export type PersistQueue<T> = { current: Promise<T> };

export function enqueueQuotationPersist<T>(
  queue: PersistQueue<T>,
  run: () => Promise<T>,
): Promise<T> {
  const queued = queue.current.then(run, run);
  queue.current = queued.then(() => null as T, () => null as T);
  return queued;
}

/** Saves are serialized within one quotation. Deletion discards work that
 * has yet to start and waits for the actual in-flight save to settle. */
export class QuotationMutations {
  private saves = new Map<string, PersistQueue<string | null>>();
  private deletions = new Map<string, Promise<boolean>>();

  isDeleting(key: string) { return this.deletions.has(key); }

  save(key: string, run: () => Promise<string | null>) {
    if (this.isDeleting(key)) return Promise.resolve(null);
    let queue = this.saves.get(key);
    if (!queue) {
      queue = { current: Promise.resolve(null) };
      this.saves.set(key, queue);
    }
    const operation = enqueueQuotationPersist(queue, () => this.isDeleting(key) ? Promise.resolve(null) : run());
    const tail = queue.current;
    void tail.then(() => { if (this.saves.get(key)?.current === tail) this.saves.delete(key); });
    return operation;
  }

  remove(key: string, run: () => Promise<boolean>) {
    const pending = this.deletions.get(key);
    if (pending) return pending;
    const operation = Promise.resolve(this.saves.get(key)?.current).then(run)
      .finally(() => { this.deletions.delete(key); });
    this.deletions.set(key, operation);
    return operation;
  }
}

type CancellationSnapshot = {
  id: string;
  updated_at: string;
  items: { id: string; included_for_line_id?: string | null }[];
};

/** A lost cancellation response is confirmed by one fresh read, without replaying the write. */
export async function confirmQuotationLineCancellation<T extends CancellationSnapshot>(
  quotationId: string,
  lineId: string,
  linkedIds: readonly string[],
  cancel: () => Promise<T>,
  load: () => Promise<T>,
): Promise<T> {
  const removedIds = new Set([lineId, ...linkedIds]);
  const confirmed = (doc: T) => doc?.id === quotationId && !!doc.updated_at && Array.isArray(doc.items)
    && doc.items.every(line => typeof line?.id === "string" && !removedIds.has(line.id) && line.included_for_line_id !== lineId);
  let failure: unknown;
  try {
    const doc = await cancel();
    if (confirmed(doc)) return doc;
  } catch (error) {
    const status = (error as { status?: number })?.status;
    if (status && status < 500 && status !== 404 && status !== 408) throw error;
    failure = error;
  }
  try {
    const doc = await load();
    if (confirmed(doc)) return doc;
  } catch (error) {
    failure ??= error;
  }
  throw failure ?? new Error("Could not confirm the product removal. Reopen the saved quotation before retrying.");
}
