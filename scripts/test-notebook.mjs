import assert from "node:assert/strict";
import {
  NOTEBOOK_COLUMNS,
  NOTEBOOK_FILTERS,
  QUOTATION_COLUMNS,
  applyCellPatch,
  columnsForView,
  formatIndianDate,
  formatRupees,
  nextCell,
  parseQuotationPrice,
  searchNotebookRows,
} from "../src/components/notebook/notebookModel.ts";

assert.deepEqual(NOTEBOOK_COLUMNS.map((column) => column.key), [
  "customer_name", "customer_phone", "address", "kitchen_type", "referred_by",
  "architect_interior_designer", "status", "notes",
]);
assert.deepEqual(QUOTATION_COLUMNS.map((column) => column.key), ["quotation_price"]);
assert.deepEqual(NOTEBOOK_FILTERS, ["all", "pending", "won", "lost", "new", "quotation"]);

const row = {
  id: "1", customer_name: "A", customer_phone: "9999999999", address: "Home", kitchen_type: "GI",
  referred_by: "R", referrer_id: null, referrer_name: "", referrer_type: null, architect_interior_designer: "I",
  status: "new", notes: "N", lost_reason: "", is_converted: false, converted_at: null,
  last_contacted_at: null, contact_attempts: 0, updated_at: "v1",
};
assert.equal(searchNotebookRows([row], "home").length, 1);
assert.equal(searchNotebookRows([row], "100000").length, 0);
assert.equal(columnsForView("followups").length, 8);
assert.equal(columnsForView("quotation").length, 9);
assert.deepEqual(columnsForView("followups", "third-floor").map((column) => column.key).includes("kitchen_type"), false);
assert.equal(columnsForView("quotation", "third-floor").length, 8);
assert.deepEqual(nextCell({ row: 0, column: 7 }, "Tab", 2, 8), { row: 1, column: 0 });
assert.deepEqual(nextCell({ row: 1, column: 0 }, "Shift+Tab", 2, 8), { row: 0, column: 7 });
assert.equal(nextCell({ row: 0, column: 0 }, "Escape", 2, 8), null);
assert.equal(applyCellPatch(row, "notes", "changed").notes, "changed");
assert.equal(row.notes, "N");
assert.equal(parseQuotationPrice("12500.50"), 12500.5);
assert.equal(parseQuotationPrice("₹1,25,000"), 125000);
assert.equal(parseQuotationPrice(".50"), 0.5);
assert.equal(parseQuotationPrice("0"), 0);
for (const invalid of ["", "-100", "oops", "100abc", "1.2.3", "NaN", "Infinity", "1e999"]) {
  assert.equal(parseQuotationPrice(invalid), null, `Invalid price must stay invalid: ${invalid}`);
}
assert.equal(formatRupees(125000), "₹1,25,000");
assert.equal(formatIndianDate("2026-08-06"), "06/08/2026");

const notebookRoot = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../app/(admin)/notebook/[floor].tsx", import.meta.url), "utf8"));
const quotationFollowUp = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../app/(admin)/notebook/[floor]/quotation-follow-up.tsx", import.meta.url), "utf8"));
const legacyView = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../app/(admin)/notebook/[floor]/[view].tsx", import.meta.url), "utf8"));
const notebookScreen = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("../src/components/notebook/NotebookScreen.tsx", import.meta.url), "utf8"));
assert.match(notebookRoot, /NotebookScreen/);
assert.match(notebookRoot, /useRequireFloorAccess/);
assert.doesNotMatch(notebookRoot, /WalkInsScreen|walkins/);
assert.match(quotationFollowUp, /NotebookScreen/);
assert.match(quotationFollowUp, /useRequireFloorAccess/);
assert.doesNotMatch(quotationFollowUp, /WalkInsScreen|walkins/);
assert.match(notebookScreen, /notebookApi\.list/);
assert.match(notebookScreen, /notebookApi\.patch/);
assert.match(notebookScreen, /notebookApi\.convert/);
assert.match(notebookScreen, /notebookApi\.contact/);
assert.match(notebookScreen, /notebookApi\.outcome/);
assert.match(notebookScreen, /notebookApi\.assignReferrer/);
assert.match(notebookScreen, /ReferrerField/);
assert.match(notebookScreen, /Lost reason/);
assert.doesNotMatch(notebookScreen, /Mark (?:as )?won|Mark client as won/);
assert.match(notebookScreen, /outcome\(floorId, outcomeRow.id, "lost"/);
assert.match(notebookScreen, /quotation_price: price/);
assert.match(notebookScreen, /Move to quotation/);
assert.match(notebookScreen, /BottomSheet/);
// Showroom vocabulary changed; notebook APIs and floor guards above remain unchanged.
assert.match(notebookScreen, /No walk-ins yet/);
assert.match(legacyView, /quotation-follow-up/);

console.log("notebook model: canonical route assertions passed");
