import type { FurnitureCharge, FurnitureDeposit } from "@/src/api/furnitureQuotations";

/** Preview uses integer arithmetic; the backend remains authoritative on save. */
function units(value: string): bigint | null {
  if (value.length > 24 || !/^\d+(\.\d{1,6})?$/.test(value.trim())) return null;
  const [whole, fraction = ""] = value.trim().split(".");
  const result = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, "0"));
  return result > 0n && result <= 1000000000000000000n ? result : null;
}
const rounded = (numerator: bigint, denominator: bigint) => (numerator + denominator / 2n) / denominator;
export function chargeCents(row: FurnitureCharge): bigint | null {
  const value = units(row.amount_rmb);
  if (value === null) return null;
  const cents = rounded(value, 10000n);
  return cents > 0n ? cents : null;
}
export function depositCents(row: FurnitureDeposit): bigint | null {
  const amount = units(row.amount), rate = units(row.rate);
  if (amount === null || rate === null || (row.currency === "RMB" && rate !== 1000000n)) return null;
  const cents = row.currency === "INR" ? rounded(amount * 100n, rate) : rounded(amount * rate, 10000000000n);
  return cents > 0n ? cents : null;
}
export function rmbText(cents: bigint | null): string {
  if (cents === null) return "—";
  const sign = cents < 0n ? "-" : "";
  const value = cents < 0n ? -cents : cents;
  return `${sign}${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}
export function ledgerTotals(charges: FurnitureCharge[], deposits: FurnitureDeposit[]) {
  const chargeValues = charges.map(chargeCents), depositValues = deposits.map(depositCents);
  const payable = chargeValues.every((value) => value !== null) ? chargeValues.reduce<bigint>((sum, value) => sum + value!, 0n) : null;
  const received = depositValues.every((value) => value !== null) ? depositValues.reduce<bigint>((sum, value) => sum + value!, 0n) : null;
  return { payable, received, balance: payable !== null && received !== null ? payable - received : null };
}
