import { cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

// Other editors may build while a browser run is active. Freeze this run's
// current export so clearing dist cannot turn valid journeys into asset 404s.
// This snapshot is rebuilt on every server start, never reused for acceptance.
const root = resolve('output/performance-export');
await rm(root, { recursive: true, force: true });
await cp(resolve('dist/client'), root, { recursive: true, errorOnExist: true });
process.env.AUDIT_ROOT = root;
process.env.AUDIT_PORT = '8098';
await import('./serve-audit.mjs');
