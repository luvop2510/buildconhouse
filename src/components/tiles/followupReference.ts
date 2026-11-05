type FollowupReference = {
  referrer_id?: string | null;
  referrer_name?: string | null;
  referrer_type?: string | null;
  reference_source?: string | null;
};

/** Preserve an unlinked follow-up reference without assigning it to a different directory entry. */
export function followupLegacyReference(source: FollowupReference | null | undefined): string {
  if (!source || !source.referrer_name?.trim()) return "";
  const name = source.referrer_name.trim();
  const kind = (source.referrer_type || "").trim().toLowerCase();
  if (source.referrer_id && (kind === "architect" || kind === "interior_designer")) return "";
  if (kind === "architect") return `ARC-${name}`;
  if (kind === "interior_designer") return `INT-${name}`;
  return name;
}
