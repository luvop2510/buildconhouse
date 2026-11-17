import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { kitchenFixtureCommand, kitchenPdfBytes, prepareKitchenFixtureCommand, uploadKitchenPdfInForm } from './kitchen-pdf-fixtures';

const headers = { 'X-Floor-Id': 'second-floor' };
async function create(api: APIRequestContext) {
  const response = await api.post('/api/kitchen-projects', { headers, data: {
    customer_id: process.env.KITCHEN_E2E_CUSTOMER_ID, idempotency_key: randomUUID(),
    lead: { site_location: `All-stage PDF date regression ${randomUUID()}` },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function load(api: APIRequestContext, id: string) {
  const response = await api.get(`/api/kitchen-projects/${id}`, { headers });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function move(api: APIRequestContext, project: any, target: string) {
  const prepared = await prepareKitchenFixtureCommand(api, project, 'move_stage', { target_stage: target });
  return kitchenFixtureCommand(api, prepared.project, 'move_stage', prepared.payload);
}
async function open(page: Page, id: string, suffix: string) {
  await page.goto(`/kitchen/${id}/${suffix}`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
}
function commandResponse(page: Page, name: string) {
  return page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === name);
}
async function choose(page: Page, id: string, filename: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId(id).click();
  await (await chooser).setFiles({ name: filename, mimeType: 'application/pdf', buffer: kitchenPdfBytes(filename) });
}

test.beforeEach(async ({ page }) => {
  page.on('dialog', dialog => { void dialog.accept(); });
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
});

test('Documents PDF record dates persist before upload and after editing across Kitchen stages', async ({ page, context }) => {
  test.setTimeout(240000);
  let project = await create(context.request);
  for (const stage of ['lead', 'visit', 'cad', 'design', 'quotation', 'order', 'production', 'installation', 'completed']) {
    if (stage !== 'lead') project = await move(context.request, project, stage);
    await open(page, project.id, 'documents');
    await page.getByTestId('kitchen-document-upload-date').fill('2026-10-27');
    await choose(page, 'kitchen-document-pick', `${stage}-historical.pdf`);
    const dated = commandResponse(page, 'attachment_date');
    await page.getByTestId('kitchen-document-upload').click();
    const response = await dated;
    expect(response.ok(), await response.text()).toBe(true);
    expect(response.request().postDataJSON().payload.upload_date).toBe('2026-10-27');
    project = await load(context.request, project.id);
    const file = project.attachments.at(-1);
    expect(file.upload_date).toBe('2026-10-27');
    expect(file.stage).toBe(stage);
    const date = page.getByTestId(`kitchen-document-${file.id}-date`);
    await expect(date).toHaveValue('2026-10-27');
    await page.reload();
    await expect(date).toHaveValue('2026-10-27');
    const before = structuredClone(project);
    await date.fill('2026-10-28');
    const saved = commandResponse(page, 'attachment_date');
    await page.getByTestId(`kitchen-document-${file.id}-date-save`).click();
    const edited = await saved;
    expect(edited.ok(), await edited.text()).toBe(true);
    expect(edited.request().postDataJSON().payload).toEqual({ attachment_id: file.id, upload_date: '2026-10-28' });
    await page.reload();
    await expect(date).toHaveValue('2026-10-28');
    project = await load(context.request, project.id);
    expect(project.attachments.find((row: any) => row.id === file.id)).toMatchObject({ upload_date: '2026-10-28', uploaded_at: file.uploaded_at, sha256: file.sha256, size_bytes: file.size_bytes });
    for (const field of ['lead', 'visit', 'cad', 'design_versions', 'quotation_versions', 'orders', 'production', 'installation']) {
      expect(project[field], `${stage} PDF date preserves ${field}`).toEqual(before[field]);
    }
    await open(page, project.id, `stages/${stage === 'production' ? 'order' : stage}`);
    await open(page, project.id, 'documents');
    await expect(date).toHaveValue('2026-10-28');
  }
});

test('Design and final production upload widgets retain historical dates through registration and replacement', async ({ page, context }) => {
  test.setTimeout(120000);
  let project = await create(context.request);
  for (const stage of ['visit', 'cad', 'design']) project = await move(context.request, project, stage);
  await open(page, project.id, 'stages/design');
  await page.getByTestId('kitchen-design-pdf-upload-date').fill('2026-10-27');
  await uploadKitchenPdfInForm(page, 'kitchen-design-pdf', 'dated-design.pdf');
  project = await load(context.request, project.id);
  const design = project.design_versions.at(-1);
  const designFile = project.attachments.find((file: any) => file.id === design.final_attachment_id);
  expect(design.upload_date).toBe('2026-10-27');
  expect(designFile.upload_date).toBe('2026-10-27');
  await page.reload();
  await expect(page.getByTestId(`kitchen-design-pdf-${designFile.id}-date`)).toHaveValue('2026-10-27');
  for (const stage of ['quotation', 'order']) project = await move(context.request, project, stage);
  await open(page, project.id, 'stages/order');
  const prefix = 'kitchen-final-production-pdf';
  await page.getByTestId(`${prefix}-upload-date`).fill('2026-10-27');
  for (const filename of ['dated-production.pdf', 'replacement-production.pdf']) {
    await choose(page, `${prefix}-pick`, filename);
    const registered = commandResponse(page, 'production_document');
    await page.getByTestId(`${prefix}-upload`).click();
    const response = await registered;
    expect(response.ok(), await response.text()).toBe(true);
    project = await load(context.request, project.id);
    const file = project.attachments.find((row: any) => row.id === project.production.final_attachment_id);
    expect(file.upload_date).toBe('2026-10-27');
    await page.reload();
    await expect(page.getByTestId(`${prefix}-${file.id}-date`)).toHaveValue('2026-10-27');
    await expect(page.getByTestId(`${prefix}-upload-date`)).toHaveValue('2026-10-27');
  }
});
