/** A price or quantity edit replaces an earlier manually entered line total. */
export function clearsManualTileTotal(patch: Record<string, unknown>): boolean {
  return ["offerRate", "rateSqft", "rateBox", "boxSqft", "totalBox", "quantityUnit"].some(key => key in patch);
}

export type TilePriceRow = {
  offerRate: string; rateSqft: string; rateBox: string; boxSqft: string; totalBox: string;
  total: string; totalEdited: boolean; quantityUnit: "Box" | "Pieces"; priceBasis?: "box" | "sqft" | "piece";
  inferredCoverage?: number;
};
const number = (value: string) => {
  const parsed = Number.parseFloat(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
export function tileUnitRate(row: TilePriceRow): number {
  const offer = row.offerRate.trim() ? number(row.offerRate) : number(row.rateSqft);
  const coverage = number(row.boxSqft);
  if (row.quantityUnit === "Box" && row.priceBasis !== "box" && coverage > 0) return Math.round(offer * coverage * 100) / 100;
  return number(row.rateBox) || offer;
}
export function tileRateWithoutCoverage(previous: TilePriceRow, offer: string): string {
  const previousOffer = previous.offerRate.trim() ? number(previous.offerRate) : number(previous.rateSqft);
  const oldBoxRate = number(previous.rateBox);
  const factor = previous.inferredCoverage ?? (previousOffer > 0 && oldBoxRate > 0 ? oldBoxRate / previousOffer : 1);
  const rate = offer.trim() ? number(offer) : number(previous.rateSqft);
  return String(Math.round(rate * factor * 100) / 100);
}
export function tileLineTotal(row: TilePriceRow): number {
  const manual = number(row.total);
  return row.totalEdited && manual > 0 ? manual : number(row.totalBox) * tileUnitRate(row);
}
