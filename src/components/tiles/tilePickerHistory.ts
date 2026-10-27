/** Prior rates are optional. A slow history read must never hold up adding a tile. */
export async function tilePickerHistory<T>(
  read: (signal: AbortSignal) => Promise<T>,
  signal: AbortSignal,
  budgetMs = 500,
): Promise<T | undefined> {
  const controller = new AbortController();
  let release: () => void = () => {};
  const unavailable = new Promise<undefined>((resolve) => {
    release = () => { controller.abort(); resolve(undefined); };
  });
  if (signal.aborted) return undefined;
  signal.addEventListener('abort', release, { once: true });
  const timer = setTimeout(release, budgetMs);
  try {
    return await Promise.race([read(controller.signal).catch(() => undefined), unavailable]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', release);
  }
}
