import { expect, type Page } from '@playwright/test';

/** Secondary controls are intentionally hidden until the user expands project details. */
export async function expandProjectDetails(page: Page) {
  const toggle = page.getByTestId('kitchen-project-details-toggle');
  await expect(toggle).toBeVisible();
  if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
}
export async function projectControl(page: Page, id: string) {
  if (id === 'kitchen-project-actions' || id === 'kitchen-convert' || id === 'kitchen-previous-stage'
    || /^kitchen-advance-(visit|cad|design|quotation|order|production|installation|completed)$/.test(id)) await expandProjectDetails(page);
  return page.getByTestId(id);
}

export async function openProjectTool(page: Page, tool: 'advance' | 'amendment' | 'site-visit') {
  const current = page.locator('[data-testid^="kitchen-"][data-testid$="-sheet"][role="dialog"]:visible');
  if (await current.isVisible()) await current.getByRole('button', { name: 'Close', exact: true }).click();
  await (await projectControl(page, 'kitchen-project-actions')).click();
  await page.getByRole('menuitem', { name: tool === 'advance' ? 'Advance details' : tool === 'amendment' ? 'Hold, cancel or revise project' : 'Site visits', exact: true }).click();
}
