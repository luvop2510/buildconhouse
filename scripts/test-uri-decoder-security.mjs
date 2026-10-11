import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import queryString from 'query-string';

// Keep the query-string 7 API used by Expo Router, including encoded usernames,
// Unicode labels, repeated parameters and malformed input handled literally.
const values = { username: 'JK PATEL', floor: 'third-floor', currency: 'RNB', label: 'ચેર / 椅子 🪑', tags: ['a&b', 'a+b'], empty: '' };
assert.deepEqual({ ...queryString.parse(queryString.stringify(values)) }, values);
assert.deepEqual({ ...queryString.parse('name=JK+PATEL&literal=%25&invalid=%E0%A4') }, { name: 'JK PATEL', literal: '%', invalid: '%E0%A4' });

// GHSA-vcc3-ghjq-m6fr: malicious percent-encoded URLs must not freeze the UI.
// Use a bounded child process so a future vulnerable dependency fails cleanly
// instead of hanging the entire test suite. Exercise the router's real consumer.
const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
  import assert from 'node:assert/strict';
  import queryString from 'query-string';
  for (const unit of ['%E0%A4', '%C0%AF', '%F0%80%80%80', '%FF%41']) {
    const malformed = unit.repeat(4096);
    const result = queryString.parse('label=' + malformed + '&floor=third-floor');
    assert.equal(result.floor, 'third-floor');
    assert.equal(typeof result.label, 'string');
    assert.ok(result.label.length > 0);
  }
`], { timeout: 5000, encoding: 'utf8' });
assert.ifError(child.error);
assert.equal(child.status, 0, child.stderr);
console.log('URI decoder: router query compatibility and four malformed URL attacks passed.');
