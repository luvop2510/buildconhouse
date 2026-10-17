import { expect, type Page } from '@playwright/test';

// React catches render failures before window.onerror sees them. Watching only
// pageerror permits a boundary/blank screen to count as a healthy route.
const runtimeConsoleError = /(?:\b(?:ReferenceError|TypeError|SyntaxError|RangeError|EvalError|URIError|AggregateError)\b|\bError:\s|Objects are not valid as a React child|Minified React error|Invalid hook call|Rendered (?:more|fewer) hooks|Maximum update depth exceeded|The above error occurred|An error occurred in the .* component|React has detected a change in the order of Hooks|Cannot update a component .* while rendering|Hydration failed|hydration mismatch|AsyncRequireError|Loading (?:module|chunk) .+ failed)/i;

export function captureRuntimeHealth(page: Page, options: { expectedErrors?: RegExp[] } = {}) {
  const errors: string[] = [];
  const record = (message: string) => {
    if (!options.expectedErrors?.some(pattern => pattern.test(message))) errors.push(message);
  };
  page.on('pageerror', error => record(error.message));
  page.on('crash', () => record('Browser page crashed'));
  page.on('response', response => {
    const url = new URL(response.url());
    if (url.origin === new URL(page.url()).origin && /^\/(?:_expo\/static|assets)\//.test(url.pathname) && response.status() >= 400) {
      record(`Asset request failed: ${url.pathname} ${response.status()}`);
    }
  });
  page.on('console', message => {
    if (message.type() === 'error' && runtimeConsoleError.test(message.text())) record(message.text());
  });
  return {
    errors,
    async assertHealthy() {
      expect(errors, 'No browser or React runtime errors').toEqual([]);
      await expect(page.getByTestId('runtime-error-boundary')).toHaveCount(0);
      await expect(page.getByTestId('route-error-boundary')).toHaveCount(0);
      await expect(page.locator('body')).not.toContainText('Unmatched Route');
    },
  };
}
