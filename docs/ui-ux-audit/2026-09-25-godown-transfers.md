# GoDown transfer release audit — 2026-09-25

## Scope and acceptance

Reviewed the GoDown inventory page, matching PO Final prompt, customer transfer sheet, customer purchase workspace, and Purchases loan notes. The target behavior is a permanent, priced GoDown allocation, with a separate temporary customer-to-customer In Box loan.

## Viewports and interaction

| Viewport | Evidence | Result |
| --- | --- | --- |
| Desktop, 1440 × 1000 | Mocked transfer journey and dialog screenshot | Pass |
| Tablet, 834 × 1112 | Mocked transfer journey and dialog screenshot | Pass |
| Phone, 390 × 844 | Mocked transfer journey and dialog screenshot | Pass |

The transfer test selects a matching PO Final line, enters a partial quantity, changes the selling price and discount, checks the net total, submits, and verifies the request body. Each viewport checks for horizontal page overflow. The phone sheet keeps the action buttons reachable while its fields scroll. Controls have labels and at least 44 px target height. The matching-order prompt stacks its action under the order details on phone.

Visual inspection found that web's modal fade briefly exposed controls underneath the sheet. Web dialogs now open without that fade; screenshots show an opaque surface and readable text. Native modal animation remains unchanged.

## Verification

- Backend unit suite: 1,273 passed.
- TypeScript, Expo lint, mobile UX contract, purchases contract, and web bundle budget: passed.
- Focused transfer Playwright journey: 3 passed across desktop, tablet, and phone.
- Isolated route and viewport audit: 225 passed across desktop, tablet, and phone, including GoDown stock, Purchases, and customer routes. It checks unavailable-data states, horizontal overflow, page errors, and key recovery flows.

An earlier broad journey run reported 334 passes and 32 failures in payment, follow-up, insights, and other unrelated journeys. That run overlapped a second Playwright invocation, which collided in the shared output directory and produced missing trace files. Its failures need a separate, serial investigation; the isolated route audit and transfer journey above ran cleanly.

## Remaining limits

The browser tests use mocked staff and stock data. They verify the interface contract and responsive behavior; the backend unit tests verify stock and PO mutations. A live authenticated transfer against production data was not performed because it would change inventory.
