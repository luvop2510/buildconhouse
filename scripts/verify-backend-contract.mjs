import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export function sourceContract() {
  const server = readFileSync(new URL('../backend/server.py', import.meta.url), 'utf8');
  const policy = readFileSync(new URL('../backend/services/password_policy.py', import.meta.url), 'utf8');
  const version = /FastAPI\([^\n]*\bversion="([^"]+)"/.exec(server)?.[1];
  const minimum = /^MIN_PASSWORD_LENGTH = (\d+)$/m.exec(policy)?.[1];
  assert(version && minimum, 'Cannot determine the checked-out backend contract');
  return { version, minimumPasswordLength: Number(minimum) };
}

export async function checkBackendContract(base, { expected = sourceContract(), request = fetch } = {}) {
  const origin = new URL(base);
  assert(origin.protocol === 'https:' && !origin.username && !origin.password &&
    !origin.search && !origin.hash && origin.pathname === '/', 'Use an HTTPS origin without credentials or path');
  const problems = [];
  let status = null;
  let deployedVersion = null;
  try {
    const response = await request(new URL('/openapi.json', origin), {
      redirect: 'error', signal: AbortSignal.timeout(25000),
    });
    status = response.status;
    if (status !== 200) problems.push('Backend OpenAPI is unavailable');
    else {
      const schema = await response.json();
      deployedVersion = typeof schema?.info?.version === 'string' ? schema.info.version : null;
      if (deployedVersion !== expected.version) problems.push('Backend API version differs from checked-out source');
      for (const [model, field] of [
        ['ChangePasswordPayload', 'new_password'], ['TeamCreatePayload', 'password'],
        ['TeamPasswordResetPayload', 'new_password'],
      ]) {
        const minimum = schema?.components?.schemas?.[model]?.properties?.[field]?.minLength;
        if (minimum !== expected.minimumPasswordLength) problems.push(`${model}.${field} password minimum differs from source`);
      }
    }
  } catch {
    // Provider exceptions may contain credentials or response bodies. Record
    // only the failed phase; a failed read must never count as compatibility.
    problems.push('Backend contract could not be read');
  }
  return { origin: origin.origin, checkedAt: new Date().toISOString(), readOnly: true,
    expected, status, deployedVersion, passed: problems.length === 0, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [base, output] = process.argv.slice(2);
  assert(base, 'Usage: node scripts/verify-backend-contract.mjs https://backend.example [report.json]');
  const report = await checkBackendContract(base);
  if (output) {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  }
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.passed ? 0 : 1;
}
