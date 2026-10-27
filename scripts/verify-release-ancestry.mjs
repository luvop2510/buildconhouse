import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

export function assertProductionBuildBranch(env = process.env) {
  if (env.VERCEL_ENV === 'production') {
    assert.equal(env.VERCEL_GIT_COMMIT_REF, 'main', 'Production builds must come from Git main; merge and deploy main');
  }
}

// A ready candidate can still omit fixes already serving production.
export function assertReleaseAncestry(candidateSha, liveDeployment, run = spawnSync) {
  const liveSha = liveDeployment.meta?.releaseSha || liveDeployment.meta?.githubCommitSha || liveDeployment.meta?.gitCommitSha;
  assert.match(liveSha || '', /^[a-f0-9]{40}$/, 'Live frontend source is unknown; reconcile production before releasing');
  assert.match(candidateSha || '', /^[a-f0-9]{40}$/);
  const main = run('git', ['ls-remote', 'origin', 'refs/heads/main'], { encoding: 'utf8' });
  assert.equal(main.status, 0, 'Cannot verify remote main; production release stopped');
  assert.equal(main.stdout.trim().split(/\s+/)[0], candidateSha, 'Only the current remote main commit may be released');
  const result = run('git', ['merge-base', '--is-ancestor', liveSha, candidateSha], { encoding: 'utf8' });
  assert.equal(result.status, 0, 'Candidate omits the current live frontend source; update from production before releasing');
  return liveSha;
}
