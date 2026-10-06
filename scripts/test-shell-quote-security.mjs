import assert from 'node:assert/strict';
import shellQuote from 'shell-quote';

// GHSA-pqg4-j6r4-53mv: a newline after a comment token could escape
// quote()'s protection. Never execute these inputs in an actual shell.
for (const terminator of ['\n', '\r', '\u2028', '\u2029']) {
  assert.throws(
    () => shellQuote.quote(['echo', 'ok', { comment: 'comment' }, `value${terminator}id;#`]),
    TypeError,
  );
}

const argumentsWithMetacharacters = ['echo', 'a b', '$(id)', 'semi;colon', 'a"b', "a'b"];
assert.deepEqual(shellQuote.parse(shellQuote.quote(argumentsWithMetacharacters)), argumentsWithMetacharacters);
assert.equal(typeof shellQuote.quote(['echo', 'ok', { comment: 'comment' }]), 'string');
console.log('shell-quote: four comment escape attacks rejected; ordinary argument quoting preserved.');
