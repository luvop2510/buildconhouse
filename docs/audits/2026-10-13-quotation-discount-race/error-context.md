# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: redesign-quotation-individual.spec.ts >> critical saved quotation individual adds edits discounts autosave and reload preserve all lines and areas
- Location: e2e/redesign-quotation-individual.spec.ts:47:5

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: 20
Received: 100

Call Log:
- Timeout 5000ms exceeded while waiting on the predicate
```

# Page snapshot

```yaml
- main "Workspace content" [ref=e10]:
  - generic [ref=e11]:
    - generic [ref=e12]:
      - button "Back to quotations" [ref=e13] [cursor=pointer]:
        - generic [ref=e14]: 
      - generic [ref=e15]:
        - generic [ref=e16]:
          - generic [ref=e17]: Q-INDIVIDUAL
          - generic [ref=e18]: Draft
        - generic [ref=e20]: Saved · 03:28 am · 6 steps
      - button "Download quotation PDF" [ref=e21] [cursor=pointer]:
        - generic [ref=e22]: 
      - button "WhatsApp quotation draft" [ref=e23] [cursor=pointer]:
        - generic [ref=e24]: 
      - button "Quotation actions" [ref=e25] [cursor=pointer]:
        - generic [ref=e26]: 
    - generic [ref=e28]:
      - generic [ref=e29]:
        - button "Edit customer and project details" [ref=e31] [cursor=pointer]:
          - generic [ref=e32]: 
          - generic [ref=e33]:
            - generic [ref=e34]: Individual customer
            - generic [ref=e35]: Add project, address & reference
          - generic [ref=e36]: Edit
          - generic [ref=e37]: 
        - generic [ref=e38]:
          - button "Master Bath, 4 products. Drag to reorder quotation sections." [ref=e41] [cursor=pointer]:
            - generic [ref=e42]: 
            - generic [ref=e43]: Master Bath
            - generic [ref=e44]: "4"
          - button "Add room" [ref=e46] [cursor=pointer]:
            - generic [ref=e47]: 
        - tablist [ref=e50]:
          - tab " Products" [ref=e51] [cursor=pointer]:
            - generic [ref=e52]: 
            - generic [ref=e53]: Products
          - tab " Quotation · 4" [ref=e54] [cursor=pointer]:
            - generic [ref=e55]: 
            - generic [ref=e56]: Quotation · 4
      - generic [ref=e60]:
        - generic [ref=e62]:
          - button "Drag Master Bath to reorder quotation sections" [ref=e63]:
            - generic [ref=e64]: 
          - generic [ref=e65] [cursor=pointer]: 
          - generic [ref=e67] [cursor=pointer]:
            - generic [ref=e68]: Master Bath
            - generic [ref=e69]: 4 items · ₹285.00
          - generic [ref=e70]:
            - button "Move Master Bath to top" [disabled]:
              - generic [ref=e71]: 
            - button "Move Master Bath up" [disabled]:
              - generic [ref=e72]: 
            - button "Move Master Bath down" [disabled]:
              - generic [ref=e73]: 
          - generic [ref=e74] [cursor=pointer]: 
          - generic [ref=e76] [cursor=pointer]: 
          - generic [ref=e78] [cursor=pointer]: 
          - generic [ref=e80] [cursor=pointer]: 
        - generic [ref=e83] [cursor=pointer]:
          - button "Reorder Saved basin" [ref=e84]:
            - generic [ref=e85]: 
          - img "Product image" [ref=e86]:
            - generic [ref=e88]:
              - generic [ref=e89]: 
              - generic [ref=e90]: OLD
          - generic [ref=e92]:
            - generic [ref=e93]:
              - generic [ref=e94]: Saved basin
              - generic [ref=e96]: ₹0.00
            - generic [ref=e97]: OLD
            - generic [ref=e98]:
              - generic [ref=e99]: 
              - textbox "Presentation area for Saved basin" [ref=e100]:
                - /placeholder: Area for PPT, e.g. Basin Area
                - text: Revised area
            - generic [ref=e101]:
              - generic [ref=e102]: 
              - generic [ref=e103]: Dimension diagram in PDF
              - checkbox "Exclude dimension diagram from PDF for Saved basin" [ref=e104]:
                - generic [ref=e105]: 
            - generic [ref=e106]:
              - generic [ref=e107]:
                - generic [ref=e108]: QTY
                - textbox [ref=e109]: "3"
              - generic [ref=e110]:
                - generic [ref=e111]: RATE
                - textbox [ref=e112]: "100"
              - generic [active] [ref=e113]:
                - generic [ref=e114]: DISC
                - generic [ref=e115]: 100%
              - generic "Show product actions" [ref=e116]: 
              - generic "Cancel product" [ref=e118]: 
        - generic [ref=e121] [cursor=pointer]:
          - button "Reorder Included mounting" [disabled]:
            - generic [ref=e122]: 
          - img "Product image" [ref=e123]:
            - generic [ref=e125]:
              - generic [ref=e126]: 
              - generic [ref=e127]: PART
          - generic [ref=e129]:
            - generic [ref=e130]:
              - generic [ref=e131]:
                - generic [ref=e132]: Included mounting
                - generic [ref=e133]: Included
                - generic [ref=e135]: Proj
              - generic [ref=e137]: ₹0.00
            - generic [ref=e138]: PART
            - generic [ref=e139]:
              - generic [ref=e140]: 
              - textbox "Presentation area for Included mounting" [ref=e141]:
                - /placeholder: Area for PPT, e.g. Basin Area
                - text: Revised area
            - generic [ref=e142]:
              - generic [ref=e143]: 
              - generic [ref=e144]: Dimension diagram in PDF
              - checkbox "Exclude dimension diagram from PDF for Included mounting" [ref=e145]:
                - generic [ref=e146]: 
            - generic [ref=e147]: Quantity follows its selected product
        - generic [ref=e150] [cursor=pointer]:
          - button "Reorder Individual product A" [ref=e151]:
            - generic [ref=e152]: 
          - img "Product image" [ref=e153]:
            - generic [ref=e155]:
              - generic [ref=e156]: 
              - generic [ref=e157]: A
          - generic [ref=e159]:
            - generic [ref=e160]:
              - generic [ref=e161]:
                - generic [ref=e162]: Individual product A
                - generic [ref=e163]: Proj
              - generic [ref=e165]: ₹95.00
            - generic [ref=e166]: A
            - generic [ref=e167]:
              - generic [ref=e168]: 
              - textbox "Presentation area for Individual product A" [ref=e169]:
                - /placeholder: Area for PPT, e.g. Basin Area
                - text: Other Area
            - generic [ref=e170]:
              - generic [ref=e171]: 
              - generic [ref=e172]: Dimension diagram in PDF
              - checkbox "Exclude dimension diagram from PDF for Individual product A" [ref=e173]:
                - generic [ref=e174]: 
            - generic [ref=e175]:
              - generic [ref=e176]:
                - generic [ref=e177]: QTY
                - textbox [ref=e178]: "1"
              - generic [ref=e179]:
                - generic [ref=e180]: RATE
                - textbox [ref=e181]: "100"
              - generic [ref=e182]:
                - generic [ref=e183]: DISC
                - generic [ref=e184]: 5%
                - generic [ref=e185]: 
              - generic "Show product actions" [ref=e186]: 
              - generic "Cancel product" [ref=e188]: 
        - generic [ref=e191] [cursor=pointer]:
          - button "Reorder Individual product B" [ref=e192]:
            - generic [ref=e193]: 
          - img "Product image" [ref=e194]:
            - generic [ref=e196]:
              - generic [ref=e197]: 
              - generic [ref=e198]: B
          - generic [ref=e200]:
            - generic [ref=e201]:
              - generic [ref=e202]:
                - generic [ref=e203]: Individual product B
                - generic [ref=e204]: Proj
              - generic [ref=e206]: ₹190.00
            - generic [ref=e207]: B
            - generic [ref=e208]:
              - generic [ref=e209]: 
              - textbox "Presentation area for Individual product B" [ref=e210]:
                - /placeholder: Area for PPT, e.g. Basin Area
                - text: Other Area
            - generic [ref=e211]:
              - generic [ref=e212]: 
              - generic [ref=e213]: Dimension diagram in PDF
              - checkbox "Exclude dimension diagram from PDF for Individual product B" [ref=e214]:
                - generic [ref=e215]: 
            - generic [ref=e216]:
              - generic [ref=e217]:
                - generic [ref=e218]: QTY
                - textbox [ref=e219]: "1"
              - generic [ref=e220]:
                - generic [ref=e221]: RATE
                - textbox [ref=e222]: "200"
              - generic [ref=e223]:
                - generic [ref=e224]: DISC
                - generic [ref=e225]: 5%
                - generic [ref=e226]: 
              - generic "Show product actions" [ref=e227]: 
              - generic "Cancel product" [ref=e229]: 
      - generic [ref=e232]:
        - button "Quotation totals, notes and discounts" [ref=e233] [cursor=pointer]:
          - generic [ref=e234]:
            - generic [ref=e235]: 4 items · Saved · 03:28 am
            - generic [ref=e236]: 
          - generic [ref=e237]: ₹285.00
        - generic [ref=e238]:
          - button "Add products to quotation" [ref=e239] [cursor=pointer]:
            - generic [ref=e240]: 
            - generic [ref=e241]: Add
          - button "Finish and review quotation" [ref=e242] [cursor=pointer]:
            - generic [ref=e243]: 
            - generic [ref=e244]: Finish
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
> 72 |   await expect.poll(() => saved().items.find((line: any) => line.id === 'line-old')?.discount_pct).toBe(20);
     |                                                                                                    ^ Error: expect(received).toBe(expected) // Object.is equality
  73 |   const parent = saved().items.find((line: any) => line.id === 'line-old');
  74 |   const part = saved().items.find((line: any) => line.id === 'line-part');
  75 |   expect(parent).toMatchObject({ qty: 3, area: 'Revised area', discount_pct: 20 });
  76 |   expect(part).toMatchObject({ qty: 3, area: 'Revised area', included_for_line_id: 'line-old' });
  77 |   // Product override 20% wins; the two individual additions inherit project 5%.
  78 |   expect(saved().items.reduce((sum: number, line: any) => sum + line.qty * line.unit_price, 0)).toBe(600);
  79 |   expect(saved().project_discount_pct).toBe(5);
  80 |   await expect(page.getByText('₹525.00', { exact: true }).first()).toBeVisible();
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