import { cp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve('output/stability-export');
await rm(root, { recursive: true, force: true });
await cp(resolve('dist/client'), root, { recursive: true, errorOnExist: true });
process.env.AUDIT_ROOT = root;
process.env.AUDIT_PORT = '8099';
await import('./serve-audit.mjs');
