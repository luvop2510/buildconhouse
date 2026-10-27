/** Native focus tracking does not require a DOM commit boundary. */
export function flushInputRestoration(update: () => void) { update(); }
