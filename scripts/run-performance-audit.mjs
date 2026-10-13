import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const productionBackend = JSON.parse(readFileSync(new URL('../eas.json', import.meta.url), 'utf8')).build.production.env.EXPO_PUBLIC_BACKEND_URL;
const auditEnv = { ...process.env, EXPO_NO_DOTENV: '1', BACKEND_URL: process.env.BACKEND_URL || productionBackend };
const python = process.env.FORGE_AUDIT_PYTHON || (existsSync('backend/.venv/bin/python') ? resolve('backend/.venv/bin/python') : 'python3');
const backend = spawnSync(python, ['-m', 'pytest', '-q', 'tests/unit/test_catalog_refresh_resilience.py', 'tests/unit/test_backend_page_performance.py', 'tests/unit/test_catalog_hydration_performance.py'], {
  cwd: resolve('backend'), stdio: 'inherit', env: {
    ...process.env, MONGO_URL: 'mongodb://localhost:27017', DB_NAME: 'forge_ci_unit_tests',
    JWT_SECRET: 'ci-unit-test-secret-not-a-real-secret-32chars', JWT_ALGORITHM: 'HS256', JWT_EXP_MINUTES: '43200',
    MEDIA_STORAGE_DRIVER: 'supabase', SUPABASE_URL: 'https://ci-placeholder.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'ci-placeholder-not-real', SUPABASE_ANON_KEY: 'ci-placeholder-not-real',
    SUPABASE_PUBLIC_BUCKET: 'forge-products', SUPABASE_PRIVATE_BUCKET: 'forge-private',
    FORGE_ALLOW_DEMO_SEED: 'false', ENVIRONMENT: 'production',
  },
});
if (backend.error) throw backend.error;
if (backend.status !== 0) process.exit(backend.status ?? 1);

// Rebuild first: a passing audit of yesterday's export is not acceptance of
// today's source. Each failure stops the audit and preserves its exit status.
for (const script of ['build', 'test:mobile-budget', 'test:frontend-performance', 'test:page-loading-performance', 'test:catalog-pagination', 'test:api-client', 'test:sound-feedback', 'test:e2e:performance']) {
  console.log(`Performance audit: npm run ${script}`);
  const result = spawnSync('npm', ['run', script], { stdio: 'inherit', env: auditEnv });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
const summary = spawnSync(process.execPath, ['scripts/summarize-performance.mjs'], { stdio: 'inherit', env: auditEnv });
if (summary.error) throw summary.error;
if (summary.status !== 0) process.exit(summary.status ?? 1);
console.log('Performance audit passed: current release export, route budgets, loading/cancellation contracts and four-device browser scenarios.');
