import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const fields = {
  EXPO_PUBLIC_LEGAL_ENTITY: 'Example Test Entity', EXPO_PUBLIC_LEGAL_ADDRESS: 'Test address',
  EXPO_PUBLIC_PRIVACY_EMAIL: 'privacy@example.invalid', EXPO_PUBLIC_SUPPORT_EMAIL: 'support@example.invalid',
  EXPO_PUBLIC_DATA_RETENTION: 'Operator-reviewed test retention', EXPO_PUBLIC_LEGAL_EFFECTIVE_DATE: '2026-10-05',
  EXPO_PUBLIC_LEGAL_JURISDICTION: 'Operator-reviewed test jurisdiction',
};
const moduleUrl = pathToFileURL(resolve('src/config/legal.ts')).href;
let version = 0;
async function read(values) {
  for (const key of Object.keys(fields)) delete process.env[key];
  Object.assign(process.env, values);
  return import(`${moduleUrl}?test=${version++}`);
}
assert.equal((await read({})).isLegalPublicationReady, false);
assert.equal((await read(fields)).isLegalPublicationReady, true);
assert.equal((await read({ ...fields, EXPO_PUBLIC_PRIVACY_EMAIL: 'privacy@example.invalid?body=bad' })).isLegalPublicationReady, false);
assert.equal((await read({ ...fields, EXPO_PUBLIC_LEGAL_EFFECTIVE_DATE: '2026-02-31' })).isLegalPublicationReady, false);
assert.equal((await read({ ...fields, EXPO_PUBLIC_DATA_RETENTION: '' })).isLegalPublicationReady, false);
console.log('Legal configuration: missing facts, valid facts, unsafe email, invalid date and absent retention checked');
