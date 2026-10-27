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
  'redesign-tile-mobile-orders.spec.ts': [
    'critical Tile Orders phone views form a readable grid and records retain identity with paired quantities',
    'critical switching Tile Orders views cancels the abandoned request and keeps the selected view usable',
    ...['/tiles/orders/missing', '/tiles/orders/brands/brand', '/tiles/orders/po/missing'].map(path => `critical Tile Orders Back works from a cold ${path} link`),
  ],
  'redesign-tile-mobile-details.spec.ts': [
    'critical tile order timeline scrolls through its final event and closes without moving the order page',
    'critical tile order phone metrics and product quantities stay grouped and the last product scrolls into view',
  ],
  'redesign-kitchen-visit-recovery.spec.ts': ['autosave', 'manual'].map(mode => `critical Kitchen Visit ${mode} confirms a lost saved response before Next CAD`),
  'redesign-followup-menu-overflow.spec.ts': [
    ...['ground-floor', 'first-floor', 'third-floor'].map(floor => `critical ${floor} selected follow-up actions fit the viewport and menus stay separate from customer details`),
    ...['owner', 'sales'].map(role => `critical ${role} follow-up salesperson filter offers Mine only to staff`),
  ],
  'redesign-quotation-workspace.spec.ts': [
    'critical quotation workspace keeps title and actions in the padded scrolling frame',
  ],
  'redesign-mobile-startup.spec.ts': [
    'critical owner navigation works after login while unrelated role permissions are pending',
    'critical delegated navigation works after login while unrelated role permissions are pending',
    'critical legacy navigation retains its applicable role matrix restrictions',
  ],
  'redesign-font-readiness.spec.ts': [
    'cold sign-in waits for decoded text and icon fonts before the first form paint',
    'failed font assets show recovery and a retry reload reaches the complete sign-in form',
    'a stalled font request reaches bounded recovery and late completion cannot reveal the form',
  ],
  'redesign-sales-simplification.spec.ts': [
    'critical streamlined sales presents real product and brand evidence with three usable destinations',
    'critical sales navigation works with keyboard and exposes customers follow-ups and unpaid balances',
    'critical summary failures retry and genuine zeros retain an honest empty state',
    'critical reporting range validates dates and remains selected across tabs and reload',
    'critical late previous-floor reads cannot relabel the selected floor',
    'critical project departments keep financial reporting when product attribution is unavailable',
    'critical all four departments preserve separate INR and RNB totals and customer identities',
    ...['Sanitary', 'Tiles', 'Kitchen', 'Furniture'].map(label => `critical ${label} reporting opens its own follow-ups and account workspace`),
    'critical all-department accounts asks for a business unit before opening its own ledger',
    'critical reference search keeps pre-order clients and the chosen reporting period in its detail link',
    'critical export sends the exact displayed brand data and reporting scope',
    'critical customer balances retain paise and select only Sales Data in the desktop sidebar',
  ],
  'redesign-sales-reference-directory.spec.ts': [
    'critical sales reference directory creates, edits and reuses one identity across floors',
  ],
  'redesign-interior-acquisition.spec.ts': [
    'critical Interior section displays acquired customers before an order is placed',
  ],
  'redesign-input-focus-shape.spec.ts': [
    ...['text', 'textarea', 'search', 'kitchen', 'purchases', 'catalog'].map(kind => `focused ${kind} indicator follows its outer field shape`),
  ],
  'redesign-kitchen-request-recovery.spec.ts': [
    ...[true,false].flatMap(confirmed => ['visit', 'quotation', 'order', 'production'].map(stage => `Kitchen ${stage} opens after a dropped read and Next ${confirmed?'confirms a saved stage':'reuses its receipt'} after a lost response`)),
  ],
  'redesign-keyboard-scroll.spec.ts': [
    'critical keyboard scroll: lower customer address retains focus and saves once without document pan',
    'critical keyboard scroll: nested staff sheet keeps lower input mounted through resize and dismissal',
    'critical keyboard scroll: oversized Kitchen notes scroll internally while the form stays anchored',
  ],
  'redesign-keyboard-no-gaps.spec.ts': [
    ...[0, 40].map(pan => `critical keyboard has no hidden chrome gaps with viewport pan ${pan}`),
  ],
  'redesign-keyboard-viewport.spec.ts': [
    'critical keyboard viewport: customer entries and save remain visible through keyboard and rotation',
    'critical keyboard viewport: staff drawer scrolls focused lower fields and preserves Phone-only input',
    'critical keyboard viewport: command search panel fits above the keyboard',
  ],
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
    'critical Walk-in register renders without waiting for the optional summary',
    'critical Furniture Follow-up expiring summary clears unrelated filters and opens its exact records',
  ],

  'responsive-customer-quotation.spec.ts': [
    ...['first-floor', 'ground-floor'].map(floor => `critical ${floor} customer only offers its supported document stages`),
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
    'critical Ground Floor dispatch labor history identifies the editor',
    'critical payment overview collapses without losing a payment draft on rotation',
    'critical payment form keeps paise, validates overpayment, scrolls and retries with the same key',
    'critical successful payment removes the settled order and shows the next customer',
  ],
  'redesign-tile-purchase-images.spec.ts': [
    ...['customer', 'supplier'].map(kind => `critical tile ${kind} purchases preserve current product photos and operational controls`),
  ],
  'redesign-sanitary-sales.spec.ts': [
    ...['first-floor', 'ground-floor'].map(floor => `critical ${floor} intake uses the selected worker instead of the owner`),
    'critical sanitary quotations group every unplaced quotation under Draft',
  ],
  'redesign-sanitary-followups.spec.ts': [
    ...['first-floor', 'ground-floor'].map(floor => `critical ${floor} follow-ups keeps draft source and salesperson without summary or priority clutter`),
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
    'critical opening home after a failed module clears the rejected import before returning',
  ],
  'redesign-godown-transfer-retry.spec.ts': [
    'critical uncertain stock transfer retains its original command through close and reopen',
    'critical retrying transfer recipients retains the entered customer and quantity',
    'critical a rejected transfer retry can be corrected without changing its command key',
    'critical pending stock transfer cannot be dismissed or submitted twice',
    'critical a committed transfer conflict is reviewed before starting another transfer',
    'critical removed customer history resolves a transfer without recreating the customer',
  ],
  'redesign-backend-startup.spec.ts': [
    'critical startup restores identity and destination without an anonymous health prerequisite',
    'critical startup identity retry restores the saved route without a minute-long health loop',
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
    'critical startup paints and hydrates without requesting the legacy head bootstrap',
    'critical startup paints its static loading indicator while recovery is pending then hydrates',
    'critical failed startup asset reloads once and reaches usable login',
    'critical repeated startup asset failure stops retrying and exposes a visible reload action',
  ],
  'runtime-health-guard.spec.ts': [
    'runtime guard rejects React-caught failures even when the page still has visible content',
    'runtime guard rejects a boundary screen without browser errors',
  ],
};
