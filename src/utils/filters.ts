/** Empty selection means all; comma-separated query values preserve legacy URLs. */
export function filterValues(value: string | null | undefined, all = "all"): string[] {
  return [...new Set((value || "").split(",").map(item => item.trim()).filter(item => item && item !== all))];
}

export function toggleFilterValue(current: string | null | undefined, choice: string, all = "all"): string {
  if (!choice || choice === all) return all;
  const selected = filterValues(current, all);
  const next = selected.includes(choice) ? selected.filter(item => item !== choice) : [...selected, choice];
  return next.length ? next.join(",") : all;
}

export function matchesFilter(value: string | null | undefined, selection: string | null | undefined, all = "all"): boolean {
  const selected = filterValues(selection, all);
  return !selected.length || selected.includes(value || "");
}
