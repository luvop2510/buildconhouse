import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const team = 'team_TNMtYYjniBWtCj1l58NEFSPG';
const project = 'prj_RuZWSvov1AkP2UDmWaea6925wWlU';

export function promoteVerified({ candidate, sha, report, cli = 'vercel', run = spawnSync }) {
  const url = new URL(candidate);
  assert.ok(url.protocol === 'https:' && url.hostname.endsWith('.vercel.app') && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Use an HTTPS candidate deployment URL');
  assert.match(sha, /^[a-f0-9]{40}$/, 'Provide the complete reviewed source SHA');
  const metadata = run(cli, ['api', `/v13/deployments/${encodeURIComponent(url.hostname)}?teamId=${team}`, '--method', 'GET'], { encoding: 'utf8' });
  assert.equal(metadata.status, 0, 'Cannot inspect deployment; production promotion stopped');
  const deployment = JSON.parse(metadata.stdout);
  assert.equal(deployment.projectId, project, 'Candidate belongs to another project');
  assert.equal(deployment.readyState, 'READY', 'Candidate is not ready');
  assert.equal(deployment.meta?.releaseSha, sha, 'Candidate source differs from reviewed source');
  const verification = run(process.execPath, [fileURLToPath(new URL('./verify-production-release.mjs', import.meta.url)), url.origin, ...(report ? [report] : [])], { stdio: 'inherit' });
  assert.equal(verification.status, 0, 'Candidate runtime/API/security verification failed; production promotion stopped');
  const browserVerification = run(process.execPath, [fileURLToPath(new URL('./verify-authenticated-release.mjs', import.meta.url)), url.origin, sha, ...(report ? [report.replace(/\.json$/, '') + '-authenticated.json'] : [])], { stdio: 'inherit' });
  assert.equal(browserVerification.status, 0, 'Candidate authenticated browser/session verification failed; production promotion stopped');
  const quotationVerification = run(process.execPath, ['--experimental-strip-types', '--no-warnings', fileURLToPath(new URL('./verify-quotation-release.mjs', import.meta.url)), url.origin, sha, ...(report ? [report.replace(/\.json$/, '') + '-quotations.json'] : [])], { stdio: 'inherit' });
  assert.equal(quotationVerification.status, 0, 'Candidate populated Sanitary/Ground quotation verification failed; production promotion stopped');
  const promotion = run(cli, ['promote', deployment.id, '--yes', '--scope', team], { stdio: 'inherit' });
  assert.equal(promotion.status, 0, 'Vercel promotion did not complete');
  return { id: deployment.id, sourceSha: sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [candidate, sha, report] = process.argv.slice(2);
  console.log(promoteVerified({ candidate, sha, report, cli: process.env.FORGE_VERCEL_CLI || 'vercel' }));
}
