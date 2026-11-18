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
