import { expect, test, type Page } from '@playwright/test';
import { mockSession } from './audit-fixtures';

async function historyAction(page: Page, name: 'Undo last change' | 'Redo change', disabled = false) {
  // Builder breakpoints use available container width: a sidebar can make a
  // 768px viewport use the actions sheet too. Follow the rendered control.
  const compact = await page.getByTestId('builder-actions').isVisible();
  if (compact) {
    await page.getByTestId('builder-actions').click();
    // Rendered rows can be visible before the overlay focus setup runs.
    // Keyboard dismissal requires the committed sheet to own focus.
    await expect(page.getByTestId('quotation-actions-sheet').getByRole('button', { name: 'Close', exact: true })).toBeFocused();
  }
  const button = compact
    ? page.getByTestId('quotation-actions-sheet').getByRole('button', { name, exact: true })
    : page.getByRole('button', { name, exact: true });
  if (disabled) {
    await expect(button).toBeDisabled();
    if (compact) {
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('quotation-actions-sheet')).toBeHidden();
    }
    return;
  }
  await expect(button).toBeEnabled();
  await button.click();
  if (compact) await expect(page.getByTestId('quotation-actions-sheet')).toBeHidden();
}

test('critical quotation history restores fields and clears redo after a new branch', async ({ page }) => {
  // Every API request is intercepted; this edits only the browser's fixture document.
  await mockSession(page, '/quotations/new', false);
  await page.route('**/api/categories**', route => route.fulfill({ json: [] }));
  await page.route('**/api/brands**', route => route.fulfill({ json: [] }));
  await page.route('**/api/quotations/recent?**', route => route.fulfill({ json: [] }));
  await page.route('**/api/products/families?**', route => route.fulfill({ json: { total: 0, items: [] } }));
  await page.goto('/quotations/new');
  await expect(page.getByTestId('quotation-workspace')).toBeVisible();
  const exit = page.getByTestId('expand-quotation-workspace');
  if (await exit.isVisible()) await exit.click();
  await page.getByTestId('quotation-details-toggle').click();
  const project = page.getByTestId('compact-hdr-project');
  const phone = page.getByTestId('compact-hdr-phone');
  await expect(project).toHaveValue('');
  await historyAction(page, 'Undo last change', true);
  await project.fill('History fixture project');
  await phone.fill('9000000001');
  await historyAction(page, 'Undo last change');
  await expect(phone).toHaveValue('');
  await expect(project).toHaveValue('History fixture project');
  await historyAction(page, 'Redo change');
  await expect(phone).toHaveValue('9000000001');
  await historyAction(page, 'Undo last change');
  await phone.fill('9000000002');
  await historyAction(page, 'Redo change', true);
  await expect(phone).toHaveValue('9000000002');
  await historyAction(page, 'Undo last change');
  await expect(phone).toHaveValue('');
  await historyAction(page, 'Undo last change');
  await expect(project).toHaveValue('');
  await historyAction(page, 'Undo last change', true);
});
