/** The directory UUID is the stable reference identity, including legacy records. */
export function referrerCode(id?: string | null, kind?: string | null): string {
  return id ? `${kind === "architect" ? "ARC" : "INT"}-${id.toUpperCase()}` : "";
}
export function referrerLabel(value: { referrer_id?: string | null; referrer_type?: string | null; referrer_name?: string | null }): string {
  return [value.referrer_name, referrerCode(value.referrer_id, value.referrer_type)].filter(Boolean).join(" · ");
}
