import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { captureRuntimeHealth } from './runtime-health';

const headers = { 'X-Floor-Id': 'second-floor' };
async function openDeletion(page: Page) {
  await page.getByTestId('kitchen-project-actions').click();
  await page.getByRole('menuitem', { name: 'Delete customer', exact: true }).click();
  return page.getByTestId('kitchen-customer-delete-dialog');
}

async function create(api: any) {
  const marker = randomUUID().replaceAll('-', '');
  const response = await api.post('/api/kitchen-projects', { headers, data: {
    idempotency_key: randomUUID(), customer: { name: `Kitchen updates ${marker.slice(0, 8)}`,
      phone: `9${BigInt(`0x${marker.slice(0, 12)}`).toString().slice(-9).padStart(9, '0')}`, address: 'Synthetic update acceptance site' },
    lead: { site_location: 'Synthetic updates' },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('forge.jwt.kind', JSON.stringify('staff'));
    localStorage.setItem('forge.active-floor', JSON.stringify('second-floor'));
  });
});

test('PDF drop highlights, rejects invalid files, saves once and downloads original bytes after reload', async ({ page, context }, info) => {
  const health = captureRuntimeHealth(page);
  const project = await create(context.request);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
  await page.getByTestId('kitchen-project-actions').click();
  await page.getByRole('menuitem', { name: 'Documents', exact: true }).click();
  const drop = page.getByTestId('kitchen-file-drop');
  await expect(drop).toBeVisible();
  const chooser = page.waitForEvent('filechooser');
  await drop.click();
  await (await chooser).setFiles({ name: 'rejected.txt', mimeType: 'text/plain', buffer: Buffer.from('invalid') });
  await page.getByTestId('kitchen-document-upload').click();
  await expect(page.getByTestId('kitchen-documents-sheet')).toContainText('Choose a PDF');
  const content = '%PDF-1.4\nKitchen drop acceptance original bytes\n%%EOF';
  const data = await page.evaluateHandle(text => {
    const value = new DataTransfer();
    value.items.add(new File([text], 'drop-original.pdf', { type: 'application/pdf' }));
    return value;
  }, content);
  await drop.dispatchEvent('dragenter', { dataTransfer: data });
  await expect(drop).toHaveAttribute('data-dragging', 'true');
  await drop.dispatchEvent('drop', { dataTransfer: data });
  await expect(drop).toHaveAttribute('data-dragging', 'false');
  await expect(page.getByTestId('kitchen-documents-sheet')).toContainText('drop-original.pdf');
  let uploads = 0;
  page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/attachments')) uploads += 1; });
  const saved = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/attachments'));
  await page.getByTestId('kitchen-document-upload').evaluate((node: HTMLElement) => { node.click(); node.click(); });
  expect((await saved).ok()).toBe(true);
  await expect(page.getByTestId('kitchen-document-upload')).toHaveCount(0);
  expect(uploads).toBe(1);
  await page.reload();
  await page.getByTestId('kitchen-project-actions').click();
  await page.getByRole('menuitem', { name: 'Documents', exact: true }).click();
  const current = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  const file = (await current.json()).attachments.find((value: any) => value.filename === 'drop-original.pdf');
  expect(file).toBeTruthy();
  const download = page.waitForEvent('download');
  await page.getByTestId(`kitchen-document-${file.id}-download`).click();
  if (info.project.name !== 'kitchen-desktop') await page.getByTestId('mobile-file-download').click();
  const result = await download;
  expect(result.suggestedFilename()).toBe('drop-original.pdf');
  expect((await readFile((await result.path())!)).toString()).toBe(content);
  await page.screenshot({ path: info.outputPath('kitchen-pdf-persisted.png'), fullPage: true });
  await health.assertHealthy();
});

test('Delete customer reviews exact records, cancels safely and removes only after explicit confirmation', async ({ page, context }, info) => {
  const health = captureRuntimeHealth(page);
  const project = await create(context.request);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
  await page.getByTestId('kitchen-project-actions').click();
  await page.getByRole('menuitem', { name: 'Delete customer', exact: true }).click();
  const dialog = page.getByTestId('kitchen-customer-delete-dialog');
  await expect(dialog).toContainText(project.customer.name);
  await expect(dialog).toContainText(project.reference);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect((await context.request.get(`/api/kitchen-projects/${project.id}`, { headers })).ok()).toBe(true);
  await page.getByTestId('kitchen-project-actions').click();
  await page.getByRole('menuitem', { name: 'Delete customer', exact: true }).click();
  await expect(page.getByTestId('kitchen-customer-delete-confirm')).toBeEnabled();
  await page.screenshot({ path: info.outputPath('kitchen-delete-confirmation.png'), fullPage: true });
  const deleted = page.waitForResponse(response => response.request().method() === 'DELETE' && response.url().includes('/kitchen-customer-deletion/'));
  await page.getByTestId('kitchen-customer-delete-confirm').click();
  expect((await deleted).ok()).toBe(true);
  await expect(page).toHaveURL(/\/kitchen$/);
  const list = await context.request.get(`/api/kitchen-projects?search=${encodeURIComponent(project.reference)}`, { headers });
  expect((await list.json()).rows).toHaveLength(0);
  await health.assertHealthy();
});

test('Delete customer pauses a queued autosave and resumes it after cancel', async ({ page, context }) => {
  const health = captureRuntimeHealth(page);
  const project = await create(context.request);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
  await page.getByTestId('kitchen-lead-details-toggle').click();
  const notes = page.getByTestId('kitchen-lead-notes');
  const commandPath = `/api/kitchen-projects/${project.id}/commands`;
  const writes: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === commandPath) writes.push(request.postDataJSON().command);
  });
  await notes.fill('Keep this autosave draft after cancelling deletion');
  const dialog = await openDeletion(page);
  await expect(dialog.getByTestId('kitchen-customer-delete-confirm')).toBeEnabled();
  await page.waitForTimeout(900); // Check beyond the autosave debounce.
  expect(writes).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(notes).toHaveValue('Keep this autosave draft after cancelling deletion');
  await expect(page.getByTestId('kitchen-lead-autosave')).toHaveText('Details saved');
  expect(writes).toEqual(['edit_lead']);
  const persisted = await context.request.get(`/api/kitchen-projects/${project.id}`, { headers });
  expect((await persisted.json()).lead.notes).toBe('Keep this autosave draft after cancelling deletion');
  await health.assertHealthy();
});

test('Delete customer waits for a failed autosave, retries contention, and reviews changed records', async ({ page, context }) => {
  const health = captureRuntimeHealth(page);
  const project = await create(context.request);
  await page.goto(`/kitchen/${project.id}/stages/lead`);
  await expect(page.getByTestId('kitchen-project-ready')).toBeAttached();
  await page.getByTestId('kitchen-lead-details-toggle').click();
  const commandPath = `/api/kitchen-projects/${project.id}/commands`;
  let releaseSave!: () => void;
  const gate = new Promise<void>(resolve => { releaseSave = resolve; });
  let saveStarted = false;
  await page.route(`**${commandPath}`, async route => {
    saveStarted = true;
    await gate;
    await route.fulfill({ status: 422, json: { detail: 'Simulated save rejection' } });
  });
  const previewPath = `/api/kitchen-customer-deletion/${project.id}`;
  const confirmations: string[] = [];
  await page.route(`**${previewPath}**`, async route => {
    if (route.request().method() !== 'DELETE') return route.continue();
    confirmations.push(new URL(route.request().url()).searchParams.get('confirmation') ?? '');
    if (confirmations.length === 1) {
      await route.fulfill({ status: 409, json: { code: 'mutation_admission_busy', detail: 'Another operation is still saving. Please try again.' } });
    } else await route.continue();
  });
  try {
    await page.getByTestId('kitchen-lead-notes').fill('Retained draft after the save failed');
    await expect.poll(() => saveStarted).toBe(true);
    const dialog = await openDeletion(page);
    const confirm = dialog.getByTestId('kitchen-customer-delete-confirm');
    await expect(dialog).toContainText('Waiting for the current save to finish');
    await expect(confirm).toBeDisabled();
    releaseSave();
    await expect(confirm).toBeEnabled();
    await expect(page.getByTestId('kitchen-lead-autosave')).toContainText('Details could not be saved');
    await confirm.click();
    await expect(dialog).toContainText('Another operation is still saving');
    await expect(confirm).toBeEnabled();
    const changed = await context.request.post(commandPath, { headers, data: {
      expected_version: project.version, idempotency_key: randomUUID(), command: 'metadata',
      payload: { target_completion_date: '2099-01-01' },
    } });
    expect(changed.ok(), await changed.text()).toBe(true);
    await confirm.click();
    await expect(dialog).toContainText('Customer or projects changed');
    await expect(confirm).toBeDisabled();
    expect(confirmations[1]).toBe(confirmations[0]);
    await dialog.getByRole('button', { name: 'Review again' }).click();
    const deleted = page.waitForResponse(response => response.request().method() === 'DELETE' && new URL(response.url()).pathname === previewPath);
    await confirm.click();
    expect((await deleted).ok()).toBe(true);
    expect(confirmations[2]).not.toBe(confirmations[0]);
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(/\/kitchen$/);
    await health.assertHealthy();
  } finally { releaseSave(); }
});
