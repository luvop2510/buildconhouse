const PLAIN_INDIAN_MOBILE_FLOORS = new Set(["ground-floor", "first-floor", "third-floor"]);

/** Display Indian mobile numbers without changing stored identities or dial links. */
export function formatPhone(value?: string | null): string {
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  if (local.length !== 10 || !/^[+\d\s().-]+$/.test(value)) return value;
  return `${digits.length === 12 ? "+91 " : ""}${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6, 8)}-${local.slice(8)}`;
}

/** Format mobile numbers for display while keeping the raw value for edits and dialing. */
export function formatDepartmentPhone(value: string | null | undefined, floorId?: string | null): string {
  if (!floorId || !PLAIN_INDIAN_MOBILE_FLOORS.has(floorId)) {
    return formatPhone(value);
  }
  if (!value || !/^\s*\+?[\d\s().-]+$/.test(value)) return value || "";
  const digits = value.replace(/[\s().-]/g, "");
  if (/^[6-9][0-9]{9}$/.test(digits)) return digits;
  if (/^\+?91[6-9][0-9]{9}$/.test(digits)) return `+91 ${digits.slice(-10)}`;
  return value;
}

export function validPhone(value: string): boolean {
  return /^(?:91)?\d{10}$/.test(value.replace(/\D/g, "")) && /^[+\d\s().-]+$/.test(value);
}
