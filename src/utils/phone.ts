/** Display Indian mobile numbers without changing stored identities or dial links. */
export function formatPhone(value?: string | null): string {
  if (!value) return "";
  const digits = value.replace(/\D/g, "");
  const local = digits.length === 12 && digits.startsWith("91") ? digits.slice(2) : digits;
  if (local.length !== 10 || !/^[+\d\s().-]+$/.test(value)) return value;
  return `${digits.length === 12 ? "+91 " : ""}${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6, 8)}-${local.slice(8)}`;
}

export function validPhone(value: string): boolean {
  return /^(?:91)?\d{10}$/.test(value.replace(/\D/g, "")) && /^[+\d\s().-]+$/.test(value);
}
