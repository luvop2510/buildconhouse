# Manual Mobile/Tablet Quotation Builder Testing Guide

## Test Configuration
- **URL**: https://buildcon-preview.preview.emergentagent.com
- **Login**: owner@forge.app / [legacy password removed; use injected test credentials]
- **Test Path**: `/(admin)/quotations/new`

## Backend Verification (Automated - PASSED ✅)
- Backend healthy: ✅ true
- MongoDB connected: ✅ true
- Products loaded: ✅ 2601
- Authentication working: ✅ JWT token generated successfully

## Test Sizes
Test the FULL add-to-quotation flow at these 3 sizes, one at a time (fresh visit to the path at each size):

1. **iPad portrait**: 810 wide × 1080 tall
2. **Android tablet**: 800 wide × 1280 tall
3. **iPhone**: 390 wide × 844 tall

## Testing Procedure (For Each Size)

### Setup
1. Open browser DevTools (F12)
2. Toggle device toolbar (Ctrl+Shift+M or Cmd+Shift+M)
3. Set custom dimensions for the current test size
4. Navigate to: `https://buildcon-preview.preview.emergentagent.com/login`
5. Login with: owner@forge.app / [legacy password removed; use injected test credentials]
6. Navigate to: `/(admin)/quotations/new`

### Checkpoint (a): Open the catalog
**Expected behavior:**
- **Phone (390px)**: Look for "Add" button in bottom footer bar (testID=`mobile-add-first`)
- **Tablets (800px, 810px)**: Look for "Browse catalog" button in empty order panel (testID=`empty-browse-catalog`)

**Test:**
- Tap the appropriate button
- Verify catalog opens with search box visible (testID=`explorer-search`)

**Screenshot:** `{size}_catalog_open.png`

**Pass criteria:**
- ✅ Catalog opens
- ✅ Search box visible
- ✅ Product grid loads
- ✅ At least four product cards are visible without scrolling the product grid
- ✅ Products are presented in a two-column, retail-style grid (not a single full-width card)
- ✅ Search, brand, category, and sort controls remain visible at the top while product results scroll

---

### Checkpoint (b): Add 2 different products
**Test:**
1. Wait for product cards to load in the catalog
2. Find product cards with "Add" buttons (testID pattern: `add-{sku}`)
3. Tap "Add" button on first product
4. Tap "Add" button on second product (different from first)

**Screenshot:** `{size}_products_added.png`

**Pass criteria:**
- ✅ First product added (toast notification appears)
- ✅ Second product added (toast notification appears)
- ✅ No errors in console

---

### Checkpoint (c): Close catalog and verify line items
**Test:**
1. Close the catalog:
   - **Phone/Tablet picker sheet**: Tap X button (top-left) or press Escape
   - **Desktop inline grid**: No close needed (already visible)
2. Observe the order/line-items list

**Screenshot:** `{size}_line_items.png`

**Pass criteria:**
- ✅ Two added products showing in line items list
- ✅ Product names readable and not truncated
- ✅ Prices visible and not overlapping (format: ₹XX,XXX.XX)
- ✅ Quantity numbers readable
- ✅ Delete/remove icon visible for each line item (trash icon or swipe action)
- ✅ Tapping delete icon removes the item OR shows confirmation

**Visual checks:**
- Are prices on a single line (not wrapped)?
- Are line items the same height (no inconsistent spacing)?
- Is there a way to duplicate a line item?

---

### Checkpoint (d): Check footer/totals area
**Test:**
1. Scroll to bottom of screen
2. Observe the footer/totals area

**Screenshot:** `{size}_footer_totals.png`

**Pass criteria:**
- ✅ Grand total number fully visible (format: ₹XX,XXX.XX)
- ✅ Total NOT cut off by screen edge
- ✅ Total NOT cut off by home indicator bar (iPhone)
- ✅ "Finish" button visible and accessible
- ✅ "Add" button visible (on phone/tablet)

**Visual checks:**
- Is the grand total number readable without scrolling?
- Is there adequate padding above the home indicator bar?
- Are all footer buttons fully visible?

---

### Checkpoint (e): Customer picker
**Test:**
1. Tap the "CUSTOMER" field near the top of the screen
2. Observe if a customer picker/list opens

**Screenshot:** `{size}_customer_picker.png`

**Test continued:**
3. Pick any customer from the list (e.g., "Rajesh Malhotra")
4. Verify picker closes
5. Verify customer name now shows in the header

**Screenshot:** `{size}_customer_selected.png`

**Pass criteria:**
- ✅ Customer picker opens when field is tapped
- ✅ Customer list is visible and scrollable
- ✅ Selecting a customer closes the picker
- ✅ Selected customer name appears in header/field
- ✅ No errors in console

---

### Checkpoint (f): Discount sheet
**Test:**
1. Tap the discount area near the bottom (may say "No project discount" or similar)
2. Observe if a sheet/panel opens

**Screenshot:** `{size}_discount_sheet.png`

**Test continued:**
3. Find the discount percentage input field
4. Type "10" into the percent field
5. Close the sheet (tap "Done" or "Apply" or press Escape)
6. Observe the grand total

**Screenshot:** `{size}_discount_applied.png`

**Pass criteria:**
- ✅ Discount sheet opens when discount area is tapped
- ✅ Percentage input field is visible and accessible
- ✅ Can type "10" into the field
- ✅ Sheet closes after applying discount
- ✅ Grand total updates to reflect 10% discount
- ✅ Discount indicator shows "Project 10%" or similar

**Calculation check:**
- Original total: ₹X
- After 10% discount: ₹(X × 0.9)
- Verify the math is correct

---

### Checkpoint (g): Empty search state
**Test:**
1. Open the catalog again (tap "Add" button or "Browse catalog")
2. Tap the search box (testID=`explorer-search`)
3. Type a nonsense search term: "zzzxxxqqq123"
4. Wait for search results to update

**Screenshot:** `{size}_empty_search.png`

**Pass criteria:**
- ✅ Search executes (product grid updates)
- ✅ Zero results shown (no product cards)
- ✅ Friendly empty-state message appears (e.g., "No products match")
- ✅ NOT just blank white space
- ✅ Empty state has icon and helpful text

**Visual checks:**
- Is the empty state centered and well-designed?
- Does it suggest clearing filters or trying a different search?

---

### Checkpoint (h): Keyboard overlap
**Test:**
1. Close the catalog (if open)
2. Tap the discount area to open the discount sheet
3. Tap the discount percent input field to focus it
4. Observe if the on-screen keyboard appears (on mobile devices)

**Screenshot:** `{size}_keyboard_visible.png`

**Alternative test:**
1. Tap the customer notes field (testID=`quote-notes-input`)
2. Observe if the on-screen keyboard appears

**Screenshot:** `{size}_keyboard_notes.png`

**Pass criteria:**
- ✅ On-screen keyboard appears when input is focused
- ✅ Input field remains visible above the keyboard (NOT hidden)
- ✅ Confirm button (if any) remains visible above the keyboard
- ✅ View scrolls/adjusts automatically to keep focused field visible
- ✅ Can type into the field without the keyboard blocking it

**Visual checks:**
- Does the view scroll when keyboard appears?
- Is the input field at least 50% visible above the keyboard?
- Can you see what you're typing?

**Note:** This test is most relevant on actual mobile devices. In desktop browser DevTools, the on-screen keyboard won't appear, but you can verify the layout accommodates it by checking if there's adequate space below input fields.

---

## Test Results Template

### iPad portrait (810×1080)
- (a) Catalog opens: ⬜ ✅ / ⬜ 🔴
- (b) Add 2 products: ⬜ ✅ / ⬜ 🔴
- (c) Line items readable: ⬜ ✅ / ⬜ 🔴
- (d) Footer totals visible: ⬜ ✅ / ⬜ 🔴
- (e) Customer picker works: ⬜ ✅ / ⬜ 🔴
- (f) Discount sheet works: ⬜ ✅ / ⬜ 🔴
- (g) Empty search state: ⬜ ✅ / ⬜ 🔴
- (h) Keyboard overlap: ⬜ ✅ / ⬜ 🔴 / ⬜ N/A (desktop)

**Issues found:**
- (List any issues with short description)

---

### Android tablet (800×1280)
- (a) Catalog opens: ⬜ ✅ / ⬜ 🔴
- (b) Add 2 products: ⬜ ✅ / ⬜ 🔴
- (c) Line items readable: ⬜ ✅ / ⬜ 🔴
- (d) Footer totals visible: ⬜ ✅ / ⬜ 🔴
- (e) Customer picker works: ⬜ ✅ / ⬜ 🔴
- (f) Discount sheet works: ⬜ ✅ / ⬜ 🔴
- (g) Empty search state: ⬜ ✅ / ⬜ 🔴
- (h) Keyboard overlap: ⬜ ✅ / ⬜ 🔴 / ⬜ N/A (desktop)

**Issues found:**
- (List any issues with short description)

---

### iPhone (390×844)
- (a) Catalog opens: ⬜ ✅ / ⬜ 🔴
- (b) Add 2 products: ⬜ ✅ / ⬜ 🔴
- (c) Line items readable: ⬜ ✅ / ⬜ 🔴
- (d) Footer totals visible: ⬜ ✅ / ⬜ 🔴
- (e) Customer picker works: ⬜ ✅ / ⬜ 🔴
- (f) Discount sheet works: ⬜ ✅ / ⬜ 🔴
- (g) Empty search state: ⬜ ✅ / ⬜ 🔴
- (h) Keyboard overlap: ⬜ ✅ / ⬜ 🔴 / ⬜ N/A (desktop)

**Issues found:**
- (List any issues with short description)

---

## Known Tool Limitation
**Automated browser testing is currently blocked** due to a systematic string parsing error in the browser automation tool (mcp_browser_automation). This is a tool-level issue, not an application bug. The same error was encountered in the previous testing session (2026-07-16).

**Evidence:**
- Backend API is healthy and working correctly (verified via curl)
- Authentication endpoint returns valid JWT tokens
- Frontend code review shows correct implementation
- Previous testing agent confirmed this is a tool limitation

**Workaround:**
Manual testing is required until the browser automation tool is fixed or an alternative testing approach is implemented.

---

## Additional Notes

### Test Data
- Use real-looking customer names (not "Test Customer")
- Use actual products from the catalog (2601 products available)
- Verify calculations are mathematically correct

### Console Errors
- Open browser DevTools Console tab
- Watch for any red errors during testing
- Report any errors found with full stack trace

### Network Requests
- Open browser DevTools Network tab
- Watch for any failed API requests (4xx, 5xx)
- Report any failed requests with status code and endpoint

### Performance
- Note any slow loading times (>3 seconds)
- Note any janky scrolling or animations
- Note any unresponsive buttons (>1 second delay)

---

## Reporting Results
After completing manual testing, update `/app/test_result.md` with:
1. Pass/fail status for each checkpoint at each size
2. Screenshots of any issues found
3. Console errors (if any)
4. Network errors (if any)
5. Overall assessment: WORKING / NEEDS FIXES / BLOCKED
