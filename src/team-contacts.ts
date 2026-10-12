// Contact fields never change account access or passwords. Blank optional
// values clear the contact; at least one email/username remains for sign-in.
export function optionalContact(value: string | null | undefined): string | null {
  return value?.trim() || null;
}

export function validateTeamContacts(email: string, username: string, phone: string, mobile: string): string | null {
  const address = email.trim();
  if (!address && !username.trim()) return "Add an email or username so this person can sign in";
  if (address && (address.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address))) return "Enter a valid email address";
  for (const [label, value] of [["Phone", phone], ["Mobile", mobile]]) {
    const number = value.trim();
    if (!number) continue;
    const digits = number.replace(/\D/g, "");
    if (number.length > 40 || !/^\+?[0-9 ()-]+$/.test(number) || digits.length < 7 || digits.length > 15) return `${label} must contain 7–15 digits, with an optional country code`;
  }
  return null;
}

export function teamErrorMessage(error: unknown, fallback: string): string {
  const detail = error && typeof error === "object" && "detail" in error ? error.detail : null;
  let value: unknown = detail;
  if (typeof detail === "string") {
    try { value = JSON.parse(detail); } catch { return detail || fallback; }
  }
  if (Array.isArray(value)) {
    const messages = value.flatMap((issue) => {
      if (!issue || typeof issue !== "object" || typeof issue.msg !== "string") return [];
      const field = Array.isArray(issue.loc) ? issue.loc.filter((part: unknown) => typeof part === "string" && part !== "body").join(" · ") : "";
      return [`${field ? `${field}: ` : ""}${issue.msg}`];
    });
    if (messages.length) return messages.join(". ");
  }
  return typeof value === "string" && value ? value : fallback;
}
