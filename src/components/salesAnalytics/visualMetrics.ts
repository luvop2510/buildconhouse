/** Only comparable, complete balances can produce a progress indicator. */
export function collectionProgress(collected: number | null | undefined, outstanding: number | null | undefined) {
 if (collected == null || outstanding == null || !Number.isFinite(collected) || !Number.isFinite(outstanding) || collected < 0 || outstanding < 0) return null;
 const total = collected + outstanding;
 return Number.isFinite(total) && total > 0 ? collected / total : null;
}
