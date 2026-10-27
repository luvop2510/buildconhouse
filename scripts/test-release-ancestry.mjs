import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { assertProductionBuildBranch, assertReleaseAncestry } from './verify-release-ancestry.mjs';

assertProductionBuildBranch({});
assertProductionBuildBranch({ VERCEL_ENV: 'preview', VERCEL_GIT_COMMIT_REF: 'feature' });
assertProductionBuildBranch({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'main' });
for (const branch of [undefined, '', 'feature']) {
  assert.throws(() => assertProductionBuildBranch({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: branch }), /must come from Git main/);
}
const releaseSha = 'a'.repeat(40);
const branchBuild = { VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'feature', VERCEL_GIT_COMMIT_SHA: releaseSha };
assertProductionBuildBranch({ ...branchBuild, BUILDCON_AUTHORIZED_RELEASE_SHA: releaseSha });
for (const authorization of ['', 'true', 'b'.repeat(40), 'a'.repeat(39)]) {
  assert.throws(() => assertProductionBuildBranch({ ...branchBuild, BUILDCON_AUTHORIZED_RELEASE_SHA: authorization }), /must come from Git main/);
}
assert.throws(() => assertProductionBuildBranch({ VERCEL_ENV: 'production', VERCEL_GIT_COMMIT_REF: 'feature', BUILDCON_AUTHORIZED_RELEASE_SHA: releaseSha }), /must come from Git main/);

// Exercise real Git ancestry, including a divergent release and missing history.
const root = mkdtempSync(join(tmpdir(), 'buildcon-release-source-'));
// Git hooks export repository selectors; cwd alone cannot isolate a test repo.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
try {
  const git = (...args) => execFileSync('git', args, { cwd: root, env: gitEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Release test'); git('config', 'user.email', 'release@example.test');
  git('commit', '--allow-empty', '-m', 'base'); const base = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'live fix'); const live = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-m', 'new feature'); const next = git('rev-parse', 'HEAD');
  git('remote', 'add', 'origin', root);
  const run = (command, args, options) => spawnSync(command, args, { ...options, cwd: root, env: gitEnv });
  assert.equal(assertReleaseAncestry(next, { meta: { releaseSha: live } }, run), live);
  git('switch', '-c', 'stale', base); git('commit', '--allow-empty', '-m', 'unrelated feature');
  const stale = git('rev-parse', 'HEAD');
  assert.throws(() => assertReleaseAncestry(stale, { meta: { releaseSha: live } }, run), /Only the current remote main/);
  git('update-ref', 'refs/heads/main', stale);
  assert.throws(() => assertReleaseAncestry(stale, { meta: { releaseSha: live } }, run), /omits the current live/);
  assert.throws(() => assertReleaseAncestry(stale, { meta: { releaseSha: 'f'.repeat(40) } }, run), /omits the current live/);
  assert.throws(() => assertReleaseAncestry(stale, {}, run), /source is unknown/);
} finally { rmSync(root, { recursive: true, force: true }); }
console.log('Release source guards: production main only, real Git ancestry and missing/divergent history reject safely.');
