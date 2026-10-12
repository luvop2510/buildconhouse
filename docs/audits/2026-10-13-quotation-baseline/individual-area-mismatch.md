# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: redesign-quotation-individual.spec.ts >> critical saved quotation individual adds edits discounts autosave and reload preserve all lines and areas
- Location: e2e/redesign-quotation-individual.spec.ts:47:5

# Error details

```
Error: expect(received).toMatchObject(expected)

- Expected  - 1
+ Received  + 1

  Object {
-   "area": "Revised area",
+   "area": "Existing area",
    "included_for_line_id": "line-old",
    "qty": 3,
  }
```

# Page snapshot

```yaml
- generic [ref=e4]:
  - generic [ref=e9]:
    - navigation "Primary" [ref=e10]:
      - generic [ref=e11]:
        - generic [ref=e12]:
          - generic "BuildCon House — Let you live better" [ref=e13]:
            - img "BuildCon House — Let you live better" [ref=e15]
          - button "Collapse sidebar" [expanded] [ref=e16] [cursor=pointer]:
            - generic [ref=e17]: 
            - generic [ref=e18]: Collapse
        - 'button "Switch workspace. Current workspace: The Sanitary Bathroom" [ref=e20] [cursor=pointer]':
          - generic [ref=e21]:
            - generic [ref=e22]: 
            - generic [ref=e23]: The Sanitary Bathroom
            - generic [ref=e24]: 
        - button "Search" [ref=e26] [cursor=pointer]:
          - generic [ref=e27]: 
          - generic [ref=e29]: ⌘K
        - generic [ref=e32]:
          - generic [ref=e33]:
            - generic [ref=e34]: Daily work
            - link "Today" [ref=e35] [cursor=pointer]:
              - /url: /dashboard
              - generic [ref=e37]: 
            - link "Walk-ins" [ref=e39] [cursor=pointer]:
              - /url: /walkins
              - generic [ref=e41]: 
            - link "Quotations" [ref=e43] [cursor=pointer]:
              - /url: /quotations
              - generic [ref=e45]: 
            - link "Catalog" [ref=e47] [cursor=pointer]:
              - /url: /catalog
              - generic [ref=e49]: 
            - link "Follow-ups" [ref=e51] [cursor=pointer]:
              - /url: /followups
              - generic [ref=e53]: 
          - generic [ref=e55]:
            - generic [ref=e56]: Records & operations
            - link "Customers" [ref=e57] [cursor=pointer]:
              - /url: /customers
              - generic [ref=e59]: 
            - link "Purchases" [ref=e61] [cursor=pointer]:
              - /url: /purchases
              - generic [ref=e63]: 
            - link "Godown stock" [ref=e65] [cursor=pointer]:
              - /url: /godown-stock
              - generic [ref=e67]: 
            - link "Payments" [ref=e69] [cursor=pointer]:
              - /url: /payments
              - generic [ref=e71]: 
            - link "Fully paid orders" [ref=e73] [cursor=pointer]:
              - /url: /payments-list
              - generic [ref=e75]: 
          - generic [ref=e77]:
            - generic [ref=e78]: Management
            - link "Notifications" [ref=e79] [cursor=pointer]:
              - /url: /notifications
              - generic [ref=e81]: 
            - link "Sales Data" [ref=e83] [cursor=pointer]:
              - /url: /sales-data
              - generic [ref=e85]: 
            - link "Team" [ref=e87] [cursor=pointer]:
              - /url: /team
              - generic [ref=e89]: 
            - link "Settings" [ref=e91] [cursor=pointer]:
              - /url: /settings
              - generic [ref=e93]: 
        - button "Account menu" [ref=e97] [cursor=pointer]:
          - generic [ref=e98]:
            - generic [ref=e99]: AO
            - generic [ref=e101]:
              - generic [ref=e102]: Audit Owner
              - generic [ref=e103]: Owner
            - generic [ref=e104]: 
    - main "Workspace content" [ref=e105]:
      - generic [ref=e106]:
        - generic [ref=e107]:
          - button "Back to quotations" [ref=e108] [cursor=pointer]:
            - generic [ref=e109]: 
            - generic [ref=e110]: Back
          - generic [ref=e111]:
            - generic [ref=e112]:
              - generic [ref=e113]: Q-INDIVIDUAL
              - generic [ref=e114]: Draft
            - generic [ref=e116]: Saved · 03:25 am · 6 steps
          - button "WhatsApp quotation draft" [ref=e117] [cursor=pointer]:
            - generic [ref=e118]: 
          - generic [ref=e119]:
            - button "Preview quotation" [ref=e120] [cursor=pointer]:
              - generic [ref=e121]: 
            - button "Download quotation PDF" [ref=e122] [cursor=pointer]:
              - generic [ref=e123]: 
              - generic [ref=e124]: PDF
            - button "Download product PPT" [ref=e125] [cursor=pointer]:
              - generic [ref=e126]: 
              - generic [ref=e127]: Product PPT
            - button "Place order" [ref=e128] [cursor=pointer]:
              - generic [ref=e129]: 
              - generic [ref=e130]: Place Order
          - generic [ref=e131]:
            - generic [ref=e132]:
              - generic [ref=e133]: ⌘Z
              - generic [ref=e134]: ·
              - generic [ref=e135]: ⇧⌘Z
              - generic [ref=e136]: ·
              - generic [ref=e137]: ⌘K
            - button "Undo last change" [ref=e138] [cursor=pointer]:
              - generic [ref=e139]: 
            - button "Redo change" [disabled]:
              - generic [ref=e140]: 
            - generic "Delete quotation" [ref=e141] [cursor=pointer]: 
        - generic [ref=e143]:
          - generic [ref=e145]:
            - generic [ref=e146]:
              - generic "Collapse brand rail" [ref=e147] [cursor=pointer]:
                - generic [ref=e148]: 
                - generic [ref=e149]: Brands
              - generic [ref=e150]:
                - generic [ref=e151]: 
                - textbox "Search brands" [ref=e152]
            - generic [ref=e154]:
              - generic [ref=e155] [cursor=pointer]:
                - generic [ref=e156]: 
                - generic [ref=e158]: All brands
                - generic [ref=e159]: "2"
              - generic [ref=e161] [cursor=pointer]:
                - generic [ref=e162]: FI
                - generic [ref=e164]: Fixture brand
                - generic [ref=e165]: "2"
                - generic [ref=e166]: 
              - generic [ref=e167]:
                - generic [ref=e168]: Quick actions
                - generic [ref=e169] [cursor=pointer]:
                  - generic [ref=e170]: 
                  - generic [ref=e171]: Custom product
                - generic [ref=e172] [cursor=pointer]:
                  - generic [ref=e173]: 
                  - generic [ref=e174]: Search catalog
                  - generic [ref=e175]: ⌘K
          - generic [ref=e177]:
            - generic [ref=e178]:
              - generic [ref=e179]:
                - generic [ref=e180]: All brands
                - generic [ref=e181]: · 2 products
              - generic [ref=e182]:
                - generic [ref=e183]: 
                - textbox "Search products by name, SKU or finish" [ref=e184]:
                  - /placeholder: Search products · SKU · finish · ⌘K
              - generic [ref=e187]:
                - generic [ref=e188] [cursor=pointer]:
                  - generic [ref=e189]: 
                  - generic [ref=e190]: Most used
                - generic [ref=e191] [cursor=pointer]:
                  - generic [ref=e192]: 
                  - generic [ref=e193]: Recent
                - generic [ref=e194] [cursor=pointer]:
                  - generic [ref=e195]: 
                  - generic [ref=e196]: Price ↑
                - generic [ref=e197] [cursor=pointer]:
                  - generic [ref=e198]: 
                  - generic [ref=e199]: Price ↓
                - generic [ref=e200] [cursor=pointer]:
                  - generic [ref=e201]: 
                  - generic [ref=e202]: A–Z
            - generic [ref=e204]:
              - generic [ref=e206]:
                - generic [ref=e207]:
                  - generic [ref=e208]:
                    - button "View Individual product A" [ref=e209] [cursor=pointer]:
                      - img "Product image" [ref=e210]:
                        - generic [ref=e212]:
                          - generic [ref=e213]: 
                          - generic [ref=e214]: A
                    - button "Save Individual product A to favorites" [ref=e216] [cursor=pointer]:
                      - generic [ref=e217]: 
                  - generic [ref=e218]:
                    - button "Details for Individual product A" [ref=e219] [cursor=pointer]:
                      - generic [ref=e220]: Individual product A
                    - generic [ref=e221]: A
                    - generic [ref=e222]: ₹100.00
                    - button "Add" [ref=e225] [cursor=pointer]:
                      - generic [ref=e226]:
                        - generic [ref=e227]: 
                        - generic [ref=e228]: Add
                    - generic [ref=e229]: 1 in this room
                    - generic [ref=e230]: A
                - generic [ref=e236]:
                  - generic [ref=e237]:
                    - button "View Individual product B" [ref=e238] [cursor=pointer]:
                      - img "Product image" [ref=e239]:
                        - generic [ref=e241]:
                          - generic [ref=e242]: 
                          - generic [ref=e243]: B
                    - button "Save Individual product B to favorites" [ref=e245] [cursor=pointer]:
                      - generic [ref=e246]: 
                  - generic [ref=e247]:
                    - button "Details for Individual product B" [ref=e248] [cursor=pointer]:
                      - generic [ref=e249]: Individual product B
                    - generic [ref=e250]: B
                    - generic [ref=e251]: ₹200.00
                    - button "Add" [ref=e254] [cursor=pointer]:
                      - generic [ref=e255]:
                        - generic [ref=e256]: 
                        - generic [ref=e257]: Add
                    - generic [ref=e258]: 1 in this room
                    - generic [ref=e259]: B
              - generic [ref=e265]: 2 of 2 products — you've reached the end
          - generic [ref=e267]:
            - button "Hide quotation panel" [expanded] [ref=e268] [cursor=pointer]:
              - generic [ref=e269]: ›
            - generic [ref=e270]:
              - generic [ref=e271]:
                - button "Edit customer and project details" [ref=e273] [cursor=pointer]:
                  - generic [ref=e274]: 
                  - generic [ref=e275]:
                    - generic [ref=e276]: Individual customer
                    - generic [ref=e277]: Add project, address & reference
                  - generic [ref=e278]: Edit
                  - generic [ref=e279]: 
                - generic [ref=e280]:
                  - button "Master Bath, 4 products. Drag to reorder quotation sections." [ref=e283] [cursor=pointer]:
                    - generic [ref=e284]: 
                    - generic [ref=e285]: Master Bath
                    - generic [ref=e286]: "4"
                  - button "Add room" [ref=e288] [cursor=pointer]:
                    - generic [ref=e289]: 
                - generic [ref=e291]:
                  - generic [ref=e293]: Quotation
                  - generic [ref=e294]: 4 products · 1 room
              - generic [ref=e295]:
                - button "Group products by presentation area" [ref=e297] [cursor=pointer]:
                  - generic [ref=e298]: 
                  - generic [ref=e299]:
                    - generic [ref=e300]: Presentation areas
                    - generic [ref=e301]: Master Bath · 2 areas
                  - generic [ref=e302]: 
                - generic [ref=e305]:
                  - generic [ref=e307]:
                    - button "Drag Master Bath to reorder quotation sections" [ref=e308]:
                      - generic [ref=e309]: 
                    - generic [ref=e310] [cursor=pointer]: 
                    - generic [ref=e312] [cursor=pointer]:
                      - generic [ref=e313]: Master Bath
                      - generic [ref=e314]: 4 items · ₹525.00
                    - generic [ref=e315]:
                      - button "Move Master Bath to top" [disabled]:
                        - generic [ref=e316]: 
                      - button "Move Master Bath up" [disabled]:
                        - generic [ref=e317]: 
                      - button "Move Master Bath down" [disabled]:
                        - generic [ref=e318]: 
                    - generic [ref=e319] [cursor=pointer]: 
                    - generic [ref=e321] [cursor=pointer]: 
                    - generic [ref=e323] [cursor=pointer]: 
                    - generic [ref=e325] [cursor=pointer]: 
                  - generic [ref=e328] [cursor=pointer]:
                    - button "Reorder Saved basin" [ref=e329]:
                      - generic [ref=e330]: 
                    - img "Product image" [ref=e331]:
                      - generic [ref=e333]:
                        - generic [ref=e334]: 
                        - generic [ref=e335]: OLD
                    - generic [ref=e337]:
                      - generic [ref=e338]:
                        - generic [ref=e339]: Saved basin
                        - generic [ref=e341]: ₹240.00
                      - generic [ref=e342]: OLD
                      - generic [ref=e343]:
                        - generic [ref=e344]: 
                        - textbox "Presentation area for Saved basin" [ref=e345]:
                          - /placeholder: Area for PPT, e.g. Basin Area
                          - text: Revised area
                      - generic [ref=e346]:
                        - generic [ref=e347]: 
                        - generic [ref=e348]: Dimension diagram in PDF
                        - checkbox "Exclude dimension diagram from PDF for Saved basin" [ref=e349]:
                          - generic [ref=e350]: 
                      - generic [ref=e351]:
                        - generic [ref=e352]:
                          - generic [ref=e353]: QTY
                          - textbox [ref=e354]: "3"
                        - generic [ref=e355]:
                          - generic [ref=e356]: RATE
                          - textbox [ref=e357]: "100"
                        - generic [active] [ref=e358]:
                          - generic [ref=e359]: DISC
                          - generic [ref=e360]: 20%
                        - generic "Show product actions" [ref=e361]: 
                        - generic "Cancel product" [ref=e363]: 
                  - generic [ref=e366] [cursor=pointer]:
                    - button "Reorder Included mounting" [disabled]:
                      - generic [ref=e367]: 
                    - img "Product image" [ref=e368]:
                      - generic [ref=e370]:
                        - generic [ref=e371]: 
                        - generic [ref=e372]: PART
                    - generic [ref=e374]:
                      - generic [ref=e375]:
                        - generic [ref=e376]:
                          - generic [ref=e377]: Included mounting
                          - generic [ref=e378]: Included
                          - generic [ref=e380]: Proj
                        - generic [ref=e382]: ₹0.00
                      - generic [ref=e383]: PART
                      - generic [ref=e384]:
                        - generic [ref=e385]: 
                        - textbox "Presentation area for Included mounting" [ref=e386]:
                          - /placeholder: Area for PPT, e.g. Basin Area
                          - text: Existing area
                      - generic [ref=e387]:
                        - generic [ref=e388]: 
                        - generic [ref=e389]: Dimension diagram in PDF
                        - checkbox "Exclude dimension diagram from PDF for Included mounting" [ref=e390]:
                          - generic [ref=e391]: 
                      - generic [ref=e392]: Quantity follows its selected product
                  - generic [ref=e395] [cursor=pointer]:
                    - button "Reorder Individual product A" [ref=e396]:
                      - generic [ref=e397]: 
                    - img "Product image" [ref=e398]:
                      - generic [ref=e400]:
                        - generic [ref=e401]: 
                        - generic [ref=e402]: A
                    - generic [ref=e404]:
                      - generic [ref=e405]:
                        - generic [ref=e406]:
                          - generic [ref=e407]: Individual product A
                          - generic [ref=e408]: Proj
                        - generic [ref=e410]: ₹95.00
                      - generic [ref=e411]: A
                      - generic [ref=e412]:
                        - generic [ref=e413]: 
                        - textbox "Presentation area for Individual product A" [ref=e414]:
                          - /placeholder: Area for PPT, e.g. Basin Area
                          - text: Other Area
                      - generic [ref=e415]:
                        - generic [ref=e416]: 
                        - generic [ref=e417]: Dimension diagram in PDF
                        - checkbox "Exclude dimension diagram from PDF for Individual product A" [ref=e418]:
                          - generic [ref=e419]: 
                      - generic [ref=e420]:
                        - generic [ref=e421]:
                          - generic [ref=e422]: QTY
                          - textbox [ref=e423]: "1"
                        - generic [ref=e424]:
                          - generic [ref=e425]: RATE
                          - textbox [ref=e426]: "100"
                        - generic [ref=e427]:
                          - generic [ref=e428]: DISC
                          - generic [ref=e429]: 5%
                          - generic [ref=e430]: 
                        - generic "Show product actions" [ref=e431]: 
                        - generic "Cancel product" [ref=e433]: 
                  - generic [ref=e436] [cursor=pointer]:
                    - button "Reorder Individual product B" [ref=e437]:
                      - generic [ref=e438]: 
                    - img "Product image" [ref=e439]:
                      - generic [ref=e441]:
                        - generic [ref=e442]: 
                        - generic [ref=e443]: B
                    - generic [ref=e445]:
                      - generic [ref=e446]:
                        - generic [ref=e447]:
                          - generic [ref=e448]: Individual product B
                          - generic [ref=e449]: Proj
                        - generic [ref=e451]: ₹190.00
                      - generic [ref=e452]: B
                      - generic [ref=e453]:
                        - generic [ref=e454]: 
                        - textbox "Presentation area for Individual product B" [ref=e455]:
                          - /placeholder: Area for PPT, e.g. Basin Area
                          - text: Other Area
                      - generic [ref=e456]:
                        - generic [ref=e457]: 
                        - generic [ref=e458]: Dimension diagram in PDF
                        - checkbox "Exclude dimension diagram from PDF for Individual product B" [ref=e459]:
                          - generic [ref=e460]: 
                      - generic [ref=e461]:
                        - generic [ref=e462]:
                          - generic [ref=e463]: QTY
                          - textbox [ref=e464]: "1"
                        - generic [ref=e465]:
                          - generic [ref=e466]: RATE
                          - textbox [ref=e467]: "200"
                        - generic [ref=e468]:
                          - generic [ref=e469]: DISC
                          - generic [ref=e470]: 5%
                          - generic [ref=e471]: 
                        - generic "Show product actions" [ref=e472]: 
                        - generic "Cancel product" [ref=e474]: 
              - generic [ref=e476]:
                - generic [ref=e477]:
                  - generic [ref=e478]: 
                  - textbox "Customer note printed on quotation PDF" [ref=e479]:
                    - /placeholder: Add a note for the customer (printed on the PDF)…
                - button "Edit quotation discounts" [ref=e480] [cursor=pointer]:
                  - generic [ref=e481]:
                    - generic [ref=e482]: Discount
                    - generic [ref=e483]: Project 5%
                  - generic [ref=e484]: 
                - generic [ref=e485]:
                  - generic [ref=e486]:
                    - generic [ref=e487]: Subtotal
                    - generic [ref=e488]: ₹600.00
                  - generic [ref=e489]:
                    - generic [ref=e490]: Discount
                    - generic [ref=e491]: − ₹75.00
                - generic [ref=e492]:
                  - generic [ref=e493]: Grand total
                  - generic [ref=e494]: ₹525.00
                - button "Finish and review quotation" [ref=e495] [cursor=pointer]:
                  - generic [ref=e496]: 
                  - generic [ref=e497]: Finish & review
  - generic:
    - generic:
      - generic: 
      - generic: Individual product B added to quotation
```

# Test source

```ts
  1  | import { expect, test, type Page } from '@playwright/test';
  2  | import { mockSession } from './audit-fixtures';
  3  | 
  4  | async function individualQuotation(page: Page) {
  5  |   await mockSession(page, '/quotations/new', false);
  6  |   let document: any = {
  7  |     id: 'q-individual', number: 'Q-INDIVIDUAL', customer_id: 'customer-one', customer_name: 'Individual customer', status: 'draft', floor_id: 'first-floor',
  8  |     rooms: ['Master Bath'], collapsed_rooms: [], updated_at: '2026-10-13T10:00:00Z',
  9  |     project_discount_pct: 5, category_discounts: {}, room_discounts: {},
  10 |     items: [
  11 |       { id: 'line-old', product_id: 'old', sku: 'OLD', name: 'Saved basin', room: 'Master Bath', area: 'Existing area', category_id: 'basins', qty: 2, unit_price: 100, discount_pct: 10 },
  12 |       { id: 'line-part', product_id: 'part', sku: 'PART', name: 'Included mounting', room: 'Master Bath', area: 'Existing area', category_id: 'basins', qty: 2, unit_price: 0, discount_pct: null, included_for_line_id: 'line-old', included_qty_per_parent: 1 },
  13 |     ],
  14 |   };
  15 |   await page.route('**/api/categories**', r => r.fulfill({ json: [{ id: 'basins', name: 'Basins' }] }));
  16 |   await page.route('**/api/brands**', r => r.fulfill({ json: [{ id: 'brand-one', name: 'Fixture brand', product_count: 2 }] }));
  17 |   await page.route('**/api/products/**', r => r.fulfill({ json: { total: 2, items: ['A', 'B'].map((sku, index) => ({
  18 |     family_key: sku, family_name: `Individual product ${sku}`, category_id: 'basins', brand_id: 'brand-one', min_price: (index + 1) * 100,
  19 |     variants: [{ id: `product-${sku}`, sku, name: `Individual product ${sku}`, price: (index + 1) * 100, mrp: (index + 1) * 100, stock: 2 }],
  20 |   })) } }));
  21 |   await page.route('**/api/customers**', r => r.fulfill({ json: [{ id: 'customer-one', name: 'Individual customer' }] }));
  22 |   await page.route('**/api/quotations/recent?**', r => r.fulfill({ json: [] }));
  23 |   await page.route(/\/api\/quotations\/q-individual(?:\?.*)?$/, async r => {
  24 |     if (r.request().method() === 'PATCH') document = { ...document, ...r.request().postDataJSON() };
  25 |     await r.fulfill({ json: document });
  26 |   });
  27 |   await page.goto('/quotations/new?quotationId=q-individual');
  28 |   await expect(page.getByTestId('line-drag-line-old')).toBeAttached();
  29 |   return () => document;
  30 | }
  31 | 
  32 | async function showLines(page: Page) {
  33 |   const tab = page.getByRole('tab', { name: /Quotation ·/ });
  34 |   if (await tab.isVisible()) await tab.click();
  35 |   await expect(page.getByTestId('qty-line-old')).toBeVisible();
  36 | }
  37 | 
  38 | test('critical quotation has individual product editing without line multi-select or batch area assignment', async ({ page }) => {
  39 |   await individualQuotation(page);
  40 |   await showLines(page);
  41 |   await expect(page.getByTestId('quotation-area-grouping')).toHaveCount(0);
  42 |   await expect(page.locator('[data-testid^="area-select-"]')).toHaveCount(0);
  43 |   await expect(page.getByTestId('apply-area')).toHaveCount(0);
  44 |   await expect(page.getByTestId('line-area-line-old')).toHaveValue('Existing area');
  45 | });
  46 | 
  47 | test('critical saved quotation individual adds edits discounts autosave and reload preserve all lines and areas', async ({ page }) => {
  48 |   const saved = await individualQuotation(page);
  49 |   const addFirst = page.getByTestId('mobile-add-first');
  50 |   if (await addFirst.isVisible()) {
  51 |     await addFirst.click();
  52 |     const picker = page.getByRole('dialog', { name: 'Add products', exact: true });
  53 |     await expect(picker).toBeVisible();
  54 |     await picker.getByTestId('add-A').click();
  55 |     await picker.getByTestId('add-B').click();
  56 |     await picker.getByTestId('picker-view-quotation').click();
  57 |   } else {
  58 |     await page.getByTestId('add-A').click();
  59 |     await page.getByTestId('add-B').click();
  60 |   }
  61 |   await showLines(page);
  62 |   const quantity = page.getByTestId('qty-line-old');
  63 |   await quantity.fill('3');
  64 |   await quantity.press('Tab');
  65 |   const area = page.getByTestId('line-area-line-old');
  66 |   await area.fill('Revised area');
  67 |   await area.press('Tab');
  68 |   await page.getByTestId('disc-line-old').click();
  69 |   await page.getByTestId('line-disc-input').fill('20');
  70 |   await page.getByTestId('apply-discount').click();
  71 |   await expect.poll(() => saved().items.length).toBe(4);
  72 |   await expect.poll(() => saved().items.find((line: any) => line.id === 'line-old')?.discount_pct).toBe(20);
  73 |   const parent = saved().items.find((line: any) => line.id === 'line-old');
  74 |   const part = saved().items.find((line: any) => line.id === 'line-part');
  75 |   expect(parent).toMatchObject({ qty: 3, area: 'Revised area', discount_pct: 20 });
> 76 |   expect(part).toMatchObject({ qty: 3, area: 'Revised area', included_for_line_id: 'line-old' });
     |                ^ Error: expect(received).toMatchObject(expected)
  77 |   // Product override 20% wins; the two individual additions inherit project 5%.
  78 |   expect(saved().subtotal).toBe(600);
  79 |   expect(saved().grand_total).toBe(525);
  80 |   await expect(page.getByText('₹525', { exact: true }).first()).toBeVisible();
  81 |   await page.reload();
  82 |   await expect(page.getByTestId('line-drag-line-old')).toBeAttached();
  83 |   await showLines(page);
  84 |   await expect(page.getByTestId('qty-line-old')).toHaveValue('3');
  85 |   await expect(page.getByTestId('line-area-line-old')).toHaveValue('Revised area');
  86 |   await expect(page.getByTestId('line-area-line-part')).toHaveValue('Revised area');
  87 |   expect(saved().items.map((line: any) => line.sku)).toEqual(['OLD', 'PART', 'A', 'B']);
  88 |   expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  89 | });
  90 | 
```