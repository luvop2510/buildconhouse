import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
if (typeof require('decode-uri-component').default !== 'function') {
  throw new Error('Install the pinned patched URI decoder before applying query-string compatibility.');
}
const queryStringPath = require.resolve('query-string');
const source = readFileSync(queryStringPath, 'utf8');
// Expo Router 55 uses query-string 7's CommonJS API. The published security
// fix in decode-uri-component 0.5 exports its decoder as an ES module default.
// Unwrap that export rather than upgrading the router/framework or copying
// the decoder implementation. Metro and supported Node versions both expose it.
const original = "const decodeComponent = require('decode-uri-component');";
const replacement = "const decodeComponent = require('decode-uri-component').default;";
if (source.includes(original)) {
  writeFileSync(queryStringPath, source.replace(original, replacement));
} else if (!source.includes(replacement)) {
  throw new Error('query-string decoder import changed; review URI decoder compatibility before building.');
}
