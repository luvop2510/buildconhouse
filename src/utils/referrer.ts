/** The directory UUID is the stable reference identity, including legacy records; only its display code is shortened. */
export function referrerCode(id?: string | null, kind?: string | null, name?: string | null): string {
  return id ? `${kind === "architect" ? "ARC" : "INT"}${name?.trim() ? `-${name.trim().split(/\s+/)[0].slice(0, 12).toUpperCase()}` : ""}-${id.slice(0, 8).toUpperCase()}` : "";
}
export function referrerLabel(value: { referrer_id?: string | null; referrer_type?: string | null; referrer_name?: string | null }): string {
  return [value.referrer_name, referrerCode(value.referrer_id, value.referrer_type, value.referrer_name)].filter(Boolean).join(" · ");
}

/** Customer-facing document reference, without a directory identifier. */
export function documentReferrerName(name: string, kind: string): string {
  return `${kind === "architect" ? "ARC" : "INT"}-${name}`;
}

/** Older reference text can contain a generated code after the person's name. */
export function documentReferenceText(value: string): string {
  const match = value.match(/^\s*(.*?)\s*·\s*(ARC|INT)-.+-[0-9a-f]{8}\s*$/i);
  if (match) return `${match[2].toUpperCase()}-${match[1]}`;
  return value.replace(/\b((?:ARC|INT)-.+)-[0-9a-f]{8}\s*$/i, "$1");
}
