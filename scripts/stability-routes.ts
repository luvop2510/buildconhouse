import { readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
}

// One inventory drives browser generation AND evidence verification. Adding a
// route automatically makes its successful execution mandatory on every device.
export function stabilityRoutes(root = process.cwd()): string[] {
  const app = join(root, 'app');
  return [...new Set(files(app).map(file => relative(app, file))
    .filter(file => /\.[jt]sx?$/.test(file) && !/(?:^|\/)[_+]/.test(file) && !/\.(?:ios|android|native)\.[jt]sx?$/.test(file))
    .map(file => '/' + file.replace(/\([^/]+\)\//g, '').replace(/(?:\.web)?\.[jt]sx?$/, '')
      .replace(/(^|\/)index$/, '').replace(/\/$/, '').replace('[floor]', 'kitchen')
      .replace('[view]', 'followups').replace('[kind]', 'salespeople').replace(/\[[^\]]+\]/g, 'audit-record'))
    .filter(path => path !== '/' && path !== '/set-new-password' && path !== '/login'))].sort();
}

const criticalRoutes = new Set(['/purchases', '/tiles/orders', '/tiles/quotation', '/quotations/new', '/godown-stock', '/sales-data', '/followups']);
export function stabilityRouteTitle(path: string): string {
  return `${criticalRoutes.has(path) ? 'critical ' : ''}${path} handles unavailable data and fits viewport`;
}

export const stabilityProjects = ['android-chrome', 'iphone-safari', 'ipad-safari', 'desktop-chrome'];

export const requiredStabilityScenarios: Record<string, string[]> = {
  'redesign-mobile-workspace.spec.ts': [
    'critical mobile shell stays fixed while the customer page header scrolls with content',
    'critical navigation stays hidden throughout mobile search and returns on blur',
  ],
  'redesign-mobile-filters.spec.ts': [
    'critical mobile sales filters retain selected business units and unfinished date ranges while hidden',
    'critical phone tile content scrolls normally and its action footer hides throughout quantity editing',
  ],
  'redesign-mobile-payments.spec.ts': [
    'critical payment summary opens matching earned, partial, refund and outstanding customers',
    'critical mobile payment history and collection filters hide without clearing selections',
    'critical fully paid filters hide and retain their business unit',
  ],
  'redesign-mobile-summary.spec.ts': [
    'critical Walk-in summary opens every matching metric and hidden filters retain selections',
    'critical Follow-up expiring summary clears unrelated filters and opens its exact records',
  ],

  'responsive-shared-floor-navigation.spec.ts': [
    ...['ground-floor', 'second-floor', 'third-floor'].map(floor => `critical ${floor} customer profile avoids sanitary purchasing requests`),
    'critical Ground dashboard avoids sanitary purchasing requests',
    'critical Ground catalog product avoids sanitary purchasing pipeline requests',
    ...['first-floor', 'ground-floor'].map(floor => `critical switching ${floor} follow-ups to Furniture clears prior customer data`),
    ...['ground-floor', 'first-floor', 'second-floor', 'third-floor'].map(floor => `critical ${floor} exposes only its supported workspaces on every navigation surface`),
    ...[['second-floor', '/notebook/furniture'], ['third-floor', '/notebook/kitchen'], ['third-floor', '/notebook/kitchen/quotation-follow-up'], ['second-floor', '/notebook/furniture/quotation']].map(([floor, path]) => `critical retired ${path} preserves ${floor} instead of opening another floor`),
    ...['ground-floor', 'second-floor', 'third-floor'].flatMap(floor => ['/purchases', '/purchases-completed', ...(floor === 'ground-floor' ? [] : ['/catalog'])].map(path => `critical ${floor} blocks a direct ${path} URL before business reads`)),
  ],
  'redesign-payments.spec.ts': [
    'critical payment overview collapses without losing a payment draft on rotation',
    'critical payment form keeps paise, validates overpayment, scrolls and retries with the same key',
    'critical successful payment removes the settled order and shows the next customer',
  ],
  'redesign-followup-notes.spec.ts': [
    'critical Won orders shows orders attributed to the current team member',
  ],
  'redesign-runtime-stability.spec.ts': [
    'critical populated imported won customer opens from the list and edits without losing stock navigation',
    'critical populated imported lost customer opens from the list and edits without losing stock navigation',
    'critical opening new quotation and full warehouse repeatedly keeps navigation and session healthy',
    'critical page render failure preserves the shell and signed-in retry recovery',
    'critical page render failure preserves the shell and signed-in navigate recovery',
    'critical a failed quotation module offers reload and retains the signed-in destination',
  ],
  'redesign-session-recovery.spec.ts': [
    'critical session restoration recovers from 503 without a password or losing its destination',
    'critical session restoration recovers from 403 without a password or losing its destination',
    'critical revoked sessions still clear local identity and require sign in',
  ],
  'responsive-navigation-recovery.spec.ts': [
    'critical staff navigation survives browser back forward and a hard reload',
    'critical customer quotation deep link recovers from an unavailable document after reload',
  ],
  'redesign-release-recovery.spec.ts': [
    'critical failed startup asset reloads once and reaches usable login',
    'critical repeated startup asset failure stops retrying and exposes a visible reload action',
  ],
  'runtime-health-guard.spec.ts': [
    'runtime guard rejects React-caught failures even when the page still has visible content',
    'runtime guard rejects a boundary screen without browser errors',
  ],
};
