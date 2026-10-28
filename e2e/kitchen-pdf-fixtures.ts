import { expect, type APIRequestContext, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export const kitchenIndiaToday = () => new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
export const kitchenPdfBytes = (name = 'Synthetic kitchen PDF') => Buffer.from(`%PDF-1.4\n${name}\n%%EOF`);
const headers = { 'X-Floor-Id': 'second-floor' };
export async function kitchenFixtureCommand(api: APIRequestContext, project: any, command: string, payload: object) {
  const response = await api.post(`/api/kitchen-projects/${project.id}/commands`, { headers, data: { expected_version: project.version, idempotency_key: randomUUID(), command, payload } });
  expect(response.ok(), `${command}: ${await response.text()}`).toBe(true);
  return response.json();
}
export async function uploadKitchenFixturePdf(api: APIRequestContext, project: any, filename = 'synthetic-kitchen.pdf') {
  const response = await api.post(`/api/kitchen-projects/${project.id}/attachments`, { headers, multipart: {
    expected_version: String(project.version), idempotency_key: randomUUID(), file: { name: filename, mimeType: 'application/pdf', buffer: kitchenPdfBytes(filename) },
  } });
  expect(response.ok(), await response.text()).toBe(true);
  const saved = await response.json();
  return { project: saved, attachment: saved.attachments.at(-1) };
}
export async function prepareKitchenFixtureCommand(api: APIRequestContext, project: any, name: string, payload: Record<string, unknown>) {
  if ((name === 'move_stage' || name === 'advance_stage') && typeof payload.target_stage === 'string') project = await prepareKitchenFixtureTransition(api, project, payload.target_stage);
  if (name === 'design_present' && !payload.final_attachment_id) {
    const uploaded = await uploadKitchenFixturePdf(api, project, `fixture-design-${project.design_versions.length + 1}.pdf`);
    project = uploaded.project;
    payload = { ...payload, attachment_ids: [uploaded.attachment.id], final_attachment_id: uploaded.attachment.id };
  }
  if (['design_share', 'design_response', 'design_handoff', 'quotation_share', 'quotation_response'].includes(name)) {
    payload = Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, ['date', 'approval_date'].includes(key) && value ? kitchenIndiaToday() : value]));
  }
  if (name === 'quotation_receive' && !project.final_design_version_id) {
    project = await kitchenFixtureCommand(api, project, 'design_update', { version_id: payload.design_version_id || project.design_versions.at(-1).id, response: 'Approved', finalize: true, reason: 'Select uploaded PDF for browser fixture' });
  }
  if (name === 'quotation_receive' && !payload.final_attachment_id) {
    const uploaded = await uploadKitchenFixturePdf(api, project, `fixture-quotation-${project.quotation_versions.length + 1}.pdf`);
    project = uploaded.project;
    payload = { ...payload, pdf_options: [{ attachment_id: uploaded.attachment.id, kitchen_type: 'GI' }], final_attachment_id: uploaded.attachment.id };
  }
  return { project, payload };
}
// These are fixture prerequisites for tests of later stages, never an application bypass.
export async function prepareKitchenFixtureTransition(api: APIRequestContext, project: any, target: string) {
  const today = kitchenIndiaToday();
  if (project.stage === 'design' && target === 'quotation') {
    let design = project.design_versions?.at(-1);
    const final = project.design_versions?.find((row: any) => row.id === project.final_design_version_id);
    if (final?.final_attachment_id && final.response === 'Approved' && final.handoff_status === 'Yes') return project;
    if (!design?.final_attachment_id) {
      const uploaded = await uploadKitchenFixturePdf(api, project, 'fixture-final-design.pdf');
      project = await kitchenFixtureCommand(api, uploaded.project, 'design_present', { attachment_ids: [uploaded.attachment.id], final_attachment_id: uploaded.attachment.id });
      design = project.design_versions.at(-1);
    }
    project = await kitchenFixtureCommand(api, project, 'design_update', {
      version_id: design.id, shared_date: today, approval_date: today, response: 'Approved', handoff_status: 'Yes',
      finalize: true, reason: 'Prepare finalized design for later-stage browser fixture',
    });
  }
  if (project.stage === 'quotation' && target === 'order') {
    const quote = project.quotation_versions?.at(-1);
    if (quote?.final_attachment_id && quote.response === 'Approved') return project;
    const uploaded = await uploadKitchenFixturePdf(api, project, 'fixture-final-quotation.pdf');
    project = uploaded.project;
    project = await kitchenFixtureCommand(api, project, quote ? 'quotation_update' : 'quotation_receive', {
      ...(quote ? { version_id: quote.id } : {}), design_version_id: project.final_design_version_id,
      pdf_options: [{ attachment_id: uploaded.attachment.id, kitchen_type: 'GI' }], final_attachment_id: uploaded.attachment.id,
      sent_status: 'Yes', shared_date: today, response: 'Approved',
    });
  }
  return project;
}
export async function uploadKitchenPdfInForm(page: Page, prefix: string, filename: string) {
  const chooser = page.waitForEvent('filechooser');
  await page.getByTestId(`${prefix}-pick`).click();
  await (await chooser).setFiles({ name: filename, mimeType: 'application/pdf', buffer: kitchenPdfBytes(filename) });
  const pending = page.waitForResponse(response => response.url().endsWith('/finish') && response.request().method() === 'POST');
  const created = prefix === 'kitchen-design-pdf' ? page.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'design_present') : undefined;
  await page.getByTestId(`${prefix}-upload`).click();
  const response = await pending;
  expect(response.ok(), await response.text()).toBe(true);
  let project = await response.json();
  const attachment = project.attachments.at(-1);
  if (created) {
    const saved = await created;
    expect(saved.ok(), await saved.text()).toBe(true);
    project = await saved.json();
    await expect(page.getByTestId('kitchen-design-version')).toContainText(`Design ${project.design_versions.at(-1).number}`);
  } else await expect(page.getByTestId(`${prefix}-${attachment.id}-final`)).toBeVisible();
  return { project, attachment };
}
