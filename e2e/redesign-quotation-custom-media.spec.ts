import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

const image = readFileSync('assets/images/favicon.png');
const photoUrl = 'https://media.example.test/custom-product.png';

async function fixture(page: Page, options: { emptyLookups?: boolean; failFirst?: boolean } = {}) {
  await page.addInitScript(() => {
    const originalFetch = window.fetch;
    (window as any).__customPhotoTransfers = [];
    window.fetch = async (...args) => {
      const body = args[1]?.body;
      if (body instanceof FormData && String(args[0]).includes('/products/custom-with-media')) {
        const file = body.get('file');
        if (file instanceof Blob) (window as any).__customPhotoTransfers.push({
          bytes: Array.from(new Uint8Array(await file.arrayBuffer())), type: file.type, size: file.size,
        });
      }
      return originalFetch(...args);
    };
  });
  await mockSession(page, '/quotations/new', false);
  const uploads: { body: Buffer; contentType: string }[] = [];
  const catalogWrites: Record<string, unknown>[] = [];
  let document: any = {
    id: 'q-custom-media', number: 'Q-CUSTOM-MEDIA', customer_id: 'buyer', customer_name: 'Photo buyer',
    status: 'draft', floor_id: 'first-floor', rooms: ['Master Bath'], items: [], updated_at: '2026-10-14T00:00:00Z',
  };
  await page.route('**/api/customers**', route => route.fulfill({ json: [{ id: 'buyer', name: 'Photo buyer' }] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: options.emptyLookups ? [] : [{ id: 'custom-brand', name: 'Custom brand' }] }));
  await page.route('**/api/categories**', route => route.fulfill({ json: options.emptyLookups ? [] : [{ id: 'basins', name: 'Basins' }] }));
  await page.route('**/api/catalog/facets**', route => route.fulfill({ json: { sizes: [] } }));
  await page.route('**/api/products/**', route => route.fulfill({ json: { total: 0, items: [] } }));
  await page.route('**/api/products/custom', route => {
    catalogWrites.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: 'custom-no-photo', images: [], variants: [], ...catalogWrites.at(-1) } });
  });
  await page.route('**/api/products/custom-with-media', route => {
    uploads.push({ body: route.request().postDataBuffer()!, contentType: route.request().headers()['content-type'] });
    if (options.failFirst && uploads.length === 1) {
      return route.fulfill({ status: 503, json: { detail: 'Photo storage temporarily unavailable. Retry your upload.' } });
    }
    const multipart = uploads.at(-1)!.body.toString();
    const productPart = multipart.match(/name="product"\r\n\r\n([^\r]*)/);
    if (!productPart) throw new Error('Custom product metadata missing from multipart upload');
    const product = JSON.parse(productPart[1]);
    return route.fulfill({ json: {
      ...product, id: 'custom-with-photo', sku: product.sku || 'CUSTOM-PHOTO', images: [photoUrl],
      hero_image_url: photoUrl, gallery: [{ id: 'custom-media', url: photoUrl, role: 'hero', is_primary: true }], variants: [],
    } });
  });
  await page.route(photoUrl, route => route.fulfill({ contentType: 'image/png', body: image }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route(/\/api\/quotations\/q-custom-media(?:\?.*)?$/, route => {
    if (route.request().method() === 'PATCH') document = { ...document, ...route.request().postDataJSON() };
    return route.fulfill({ json: document });
  });
  await page.goto('/quotations/new?quotationId=q-custom-media');
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  await expect(page.getByTestId('builder-reference-loading')).toHaveCount(0);
  return { uploads, catalogWrites, saved: () => document };
}

async function openCustom(page: Page) {
  await page.getByTestId('explorer-custom-product').or(page.getByTestId('rail-custom-product')).filter({ visible: true }).first().click();
  const custom = page.getByRole('dialog', { name: 'Custom product', exact: true });
  await expect(custom).toBeVisible();
  return custom;
}

async function selectPhoto(page: Page, bytes = image) {
  await expect(page.getByTestId('cp-photo')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId('cp-photo').click();
  await (await chooser).setFiles({ name: 'chosen-product.png', mimeType: 'image/png', buffer: bytes });
  await expect(page.getByTestId('cp-photo-preview')).toBeVisible();
}

async function review(page: Page) {
  const button = page.getByTestId('mobile-review-quotation');
  if (await button.isVisible()) await button.click();
  const quotationTab = page.getByRole('tab', { name: /Quotation ·/ });
  if (await quotationTab.isVisible()) await quotationTab.click();
}

function field(body: Buffer, name: string) {
  return body.toString().match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)`))?.[1];
}

test('critical custom catalog photo retries preserve metadata and request identity, then quotation image survives reload', async ({ page }, info) => {
  const state = await fixture(page, { failFirst: true });
  const custom = await openCustom(page);
  await custom.getByTestId('cp-name').fill('Measured photo basin');
  await custom.getByTestId('cp-price').fill('450');
  await custom.getByLabel('Custom product description').fill('Customer supplied finish');
  await selectPhoto(page);
  await custom.getByTestId('cp-commit').click();
  await expect(custom).toBeVisible();
  await expect(page.getByText('Photo storage temporarily unavailable. Retry your upload.', { exact: true })).toBeVisible();
  await expect(custom.getByTestId('cp-name')).toHaveValue('Measured photo basin');
  await expect(custom.getByTestId('cp-photo-preview')).toBeVisible();
  expect(state.saved().items).toHaveLength(0);
  expect(state.catalogWrites).toHaveLength(0);
  await custom.getByTestId('cp-commit').click();
  await expect(custom).not.toBeVisible();
  await expect.poll(() => state.saved().items.length).toBe(1);
  expect(state.uploads).toHaveLength(2);
  expect(state.uploads[0].contentType).toContain('multipart/form-data; boundary=');
  // WebKit's interception protocol serializes multipart binary as UTF-8 text;
  // observe the actual browser FormData bytes before fetch for exact fidelity.
  // Keep exact byte fidelity without serializing two large integer arrays
  // through WebKit's trace/protocol; that consumed most of the test deadline.
  const transferred = await page.evaluate(async () => Promise.all(
    (window as any).__customPhotoTransfers.map(async ({ bytes, type, size }: { bytes: number[]; type: string; size: number }) => {
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
      return { sha256: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join(''), type, size };
    }),
  ));
  const expectedTransfer = { sha256: createHash('sha256').update(image).digest('hex'), type: 'image/png', size: image.length };
  expect(transferred).toEqual([expectedTransfer, expectedTransfer]);
  const requestId = field(state.uploads[0].body, 'request_id');
  expect(requestId).toBeTruthy();
  expect(field(state.uploads[1].body, 'request_id')).toBe(requestId);
  expect(field(state.uploads[0].body, 'product')).toBe(field(state.uploads[1].body, 'product'));
  expect(field(state.uploads[1].body, 'keep_in_catalog')).toBe('true');
  expect(state.saved().items[0]).toMatchObject({ name: 'Measured photo basin', unit_price: 450, image: photoUrl, description: 'Customer supplied finish' });
  await page.reload();
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  await review(page);
  await expect(page.getByText('Measured photo basin', { exact: true })).toBeVisible();
  await expect.poll(() => page.locator('img').evaluateAll(elements => elements.some(element => element instanceof HTMLImageElement && element.src === 'https://media.example.test/custom-product.png' && element.complete && element.naturalWidth > 0))).toBe(true);
  await page.screenshot({ path: info.outputPath('custom-product-photo-persisted.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical one-off custom photo works with no catalog lookups and remains intact across orientation and reload', async ({ page }, info) => {
  const state = await fixture(page, { emptyLookups: true });
  const custom = await openCustom(page);
  await custom.getByTestId('cp-save').click();
  await custom.getByTestId('cp-name').fill('One-off photo shelf');
  await custom.getByTestId('cp-price').fill('900');
  await selectPhoto(page);
  const viewport = page.viewportSize()!;
  if (viewport.width < 1100) {
    await page.setViewportSize({ width: viewport.height, height: viewport.width });
    await expect(custom).toBeVisible();
    await expect(custom.getByTestId('cp-name')).toHaveValue('One-off photo shelf');
    await expect(custom.getByTestId('cp-photo-preview')).toBeVisible();
  }
  await custom.getByTestId('cp-commit').click();
  await expect(custom).not.toBeVisible();
  await expect.poll(() => state.saved().items.length).toBe(1);
  expect(state.uploads).toHaveLength(1);
  expect(state.catalogWrites).toHaveLength(0);
  expect(field(state.uploads[0].body, 'keep_in_catalog')).toBe('false');
  expect(state.saved().items[0]).toMatchObject({ name: 'One-off photo shelf', image: photoUrl, unit_price: 900 });
  await page.setViewportSize(viewport);
  await page.reload();
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  await review(page);
  await expect(page.getByText('One-off photo shelf', { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath('inline-product-photo-persisted.png') });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical removing a selected custom photo avoids upload and reopening starts with a clean form', async ({ page }) => {
  const state = await fixture(page);
  const custom = await openCustom(page);
  await custom.getByTestId('cp-name').fill('Text-only custom basin');
  await custom.getByTestId('cp-price').fill('400');
  await selectPhoto(page);
  await custom.getByTestId('cp-photo-remove').click();
  await expect(custom.getByTestId('cp-photo-preview')).toHaveCount(0);
  await custom.getByTestId('cp-commit').click();
  await expect(custom).not.toBeVisible();
  await expect.poll(() => state.saved().items.length).toBe(1);
  expect(state.uploads).toHaveLength(0);
  expect(state.catalogWrites).toEqual([expect.objectContaining({ name: 'Text-only custom basin', price: 400 })]);
  const reopened = await openCustom(page);
  await expect(reopened.getByTestId('cp-name')).toHaveValue('');
  await expect(reopened.getByTestId('cp-photo-preview')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('critical large custom photos are prepared below the hosted request limit before upload', async ({ page }) => {
  const state = await fixture(page);
  const custom = await openCustom(page);
  await custom.getByTestId('cp-name').fill('Large photo custom basin');
  await custom.getByTestId('cp-price').fill('800');
  // PNG decoders ignore trailing bytes: keep a real decodable image while
  // exercising the source-file byte limit without a slow random image fixture.
  const largePhoto = Buffer.concat([image, Buffer.alloc(4 * 1024 * 1024)]);
  await selectPhoto(page, largePhoto);
  await custom.getByTestId('cp-commit').click();
  await expect(custom).not.toBeVisible();
  await expect.poll(() => state.saved().items.length).toBe(1);
  expect(state.uploads).toHaveLength(1);
  expect(state.uploads[0].body.length).toBeLessThan(3 * 1024 * 1024 + 4096);
  expect(state.uploads[0].body.toString()).toMatch(/Content-Type: image\/(?:webp|jpeg)/i);
  expect(state.saved().items[0]).toMatchObject({ name: 'Large photo custom basin', image: photoUrl });
});

test('critical product gallery editor uploads a chosen photo, preserves failed preview and reloads the stored gallery', async ({ page }) => {
  await mockSession(page, '/catalog/gallery-product', false);
  let product: Record<string, unknown> = {
    id: 'gallery-product', sku: 'GALLERY-1', name: 'Gallery fixture basin', brand_id: 'gallery-brand', category_id: 'basins',
    price: 1000, mrp: 1000, images: [], variants: [], stock: 1, tags: [],
  };
  let media: Record<string, unknown>[] = [];
  let uploads = 0;
  await page.route('**/api/products/**', route => route.fulfill({ json: { items: [], total: 0 } }));
  await page.route('**/api/products/gallery-product', route => route.fulfill({ json: product }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [{ id: 'gallery-brand', name: 'Gallery brand' }] }));
  await page.route('**/api/categories**', route => route.fulfill({ json: [{ id: 'basins', name: 'Basins' }] }));
  await page.route('**/api/purchases/items?**', route => route.fulfill({ json: { items: [] } }));
  await page.route(photoUrl, route => route.fulfill({ contentType: 'image/png', body: image }));
  await page.route('**/api/products/gallery-product/media', route => {
    if (route.request().method() !== 'POST') return route.fulfill({ json: media });
    uploads += 1;
    expect(route.request().headers()['content-type']).toContain('multipart/form-data; boundary=');
    if (uploads === 1) return route.fulfill({ status: 503, json: { detail: 'Gallery storage temporarily unavailable' } });
    media = [{ id: 'gallery-media', public_url: photoUrl, source_type: 'upload', role: 'hero', is_primary: true, sort_order: 0, quality: 'high' }];
    product = { ...product, images: [photoUrl], hero_image_url: photoUrl, gallery: [{ id: 'gallery-media', url: photoUrl, role: 'hero', is_primary: true }] };
    return route.fulfill({ json: media[0] });
  });
  await page.goto('/catalog/gallery-product');
  await expect(page.getByTestId('manage-images-btn')).toBeVisible();
  await page.getByTestId('manage-images-btn').click();
  const editor = page.getByTestId('product-editor');
  await expect(editor).toBeVisible();
  await editor.getByTestId('product-editor-tab-media').click();
  await expect(editor.getByTestId('image-add-btn')).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await editor.getByTestId('image-add-btn').click();
  await (await chooser).setFiles({ name: 'gallery-product.png', mimeType: 'image/png', buffer: image });
  await expect(editor.getByTestId('image-preview-save')).toBeVisible();
  await editor.getByTestId('image-preview-save').click();
  await expect(page.getByText('Gallery storage temporarily unavailable', { exact: true })).toBeVisible();
  await expect(editor.getByTestId('image-preview-save')).toBeEnabled();
  expect(media).toHaveLength(0);
  await editor.getByTestId('image-preview-save').click();
  await expect(editor.getByTestId('media-tile-gallery-media')).toBeVisible();
  expect(uploads).toBe(2);
  await page.reload();
  await expect(page.getByTestId('manage-images-btn')).toBeVisible();
  await expect.poll(() => page.locator('img').evaluateAll(elements => elements.some(element => element instanceof HTMLImageElement && element.src === 'https://media.example.test/custom-product.png' && element.complete && element.naturalWidth > 0))).toBe(true);
  await page.getByTestId('manage-images-btn').click();
  await editor.getByTestId('product-editor-tab-media').click();
  await expect(editor.getByTestId('media-tile-gallery-media')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});
