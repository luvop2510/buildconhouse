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
  return [...new Set(files(app)
    .filter(file => /\.[jt]sx?$/.test(file) && !/\/_|\/\+/.test(file) && !/\.(?:ios|android|native)\.[jt]sx?$/.test(file))
    .map(file => '/' + relative(app, file).replace(/\([^/]+\)\//g, '').replace(/(?:\.web)?\.[jt]sx?$/, '')
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
