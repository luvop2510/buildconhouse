import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const monitoring = readFileSync("src/lib/monitoring.ts", "utf8");
const webLayout = readFileSync("app/_layout.web.tsx", "utf8");
const privacyPolicy = readFileSync("src/components/PrivacyPolicyContent.tsx", "utf8");

assert.match(monitoring, /sendDefaultPii: false/);
assert.match(monitoring, /maxBreadcrumbs: 0/);
assert.match(monitoring, /request: undefined/);
assert.match(monitoring, /user: undefined/);
assert.match(monitoring, /breadcrumbs: \[\]/);
assert.match(monitoring, /routeTemplate\(window\.location\.pathname\)/);
assert.match(monitoring, /DEFAULT_TRACE_SAMPLE_RATE = 0\.05/);
assert.match(monitoring, /DEFAULT_WEB_VITAL_SAMPLE_RATE = 0\.1/);
assert.match(monitoring, /"lcp_ms"/);
assert.match(monitoring, /"cls"/);
assert.match(monitoring, /"inp_ms"/);
assert.match(monitoring, /"long_task_ms"/);
assert.doesNotMatch(monitoring, /tracesSampleRate: 0,/);
assert.match(webLayout, /initSentry\(\); initPerformanceSignals\(\);/);
assert.match(privacyPolicy, /sampled technical performance/);
assert.match(privacyPolicy, /request\n\s*bodies, query strings/);

console.log("privacy-safe monitoring contract verified.");

// Run the real initialization path with a failing optional SDK. Startup must
// continue without an unhandled rejection, and a later attempt may retry.
const { default: ts } = await import("typescript");
const { default: vm } = await import("node:vm");
const module = { exports: {} };
let attempts = 0;
const warnings = [];
const unhandled = [];
const onUnhandled = error => unhandled.push(error);
process.on("unhandledRejection", onUnhandled);
try {
  vm.runInNewContext(ts.transpileModule(monitoring, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module, exports: module.exports,
    process: { env: { EXPO_PUBLIC_SENTRY_DSN: "https://public@example.test/1" } },
    console: { warn: value => warnings.push(value) },
    require: () => { attempts += 1; throw new Error("SDK failed with confidential request data"); },
  });
  module.exports.initSentry();
  await new Promise(resolve => setImmediate(resolve));
  module.exports.initSentry();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 2, "failed initialization permits a retry");
  assert.deepEqual(unhandled, [], "optional monitoring cannot crash app startup");
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every(value => !value.includes("confidential")));
} finally {
  process.removeListener("unhandledRejection", onUnhandled);
}
console.log("Monitoring initialization failure/retry regression passed.");

let configuration;
const safeModule = { exports: {} };
vm.runInNewContext(ts.transpileModule(monitoring, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, {
  module: safeModule, exports: safeModule.exports,
  process: { env: { EXPO_PUBLIC_SENTRY_DSN: "https://public@example.test/1" } },
  console, require: () => ({ init: options => { configuration = options; } }),
});
safeModule.exports.initSentry();
await new Promise(resolve => setImmediate(resolve));
const confidential = "CONFIDENTIAL_CREDENTIAL";
const event = { message: confidential, extra: { password: confidential }, tags: { secret: confidential },
  user: { email: confidential }, request: { body: confidential }, breadcrumbs: [{ message: confidential }],
  transaction: '/customers/private-customer-id', contexts: { custom: { secret: confidential } },
  spans: [{ description: confidential }], exception: { values: [{ value: confidential,
    stacktrace: { frames: [{ filename: `https://example.test/index.js?token=${confidential}`, lineno: 12, vars: { secret: confidential }, context_line: confidential }] } }] } };
for (const callback of [configuration.beforeSend, configuration.beforeSendTransaction]) {
  const safe = callback(event);
  assert.ok(!JSON.stringify(safe).includes(confidential), 'telemetry must discard arbitrary credential-bearing fields');
  assert.equal(safe.exception.values[0].stacktrace.frames[0].lineno, 12);
}
const metric = configuration.beforeSend({ message: 'web_vital', tags: { metric: 'lcp_ms', route: '/customers/private-customer-id' }, extra: { value: 42, secret: confidential } });
assert.equal(metric.extra.value,42);
assert.equal(metric.tags.route,'/customers/:id');
assert.ok(!JSON.stringify(metric).includes(confidential));
console.log('Telemetry allowlist preserves numeric metrics and removes credential-bearing event fields.');

// A route boundary reports errors React has already caught. Optional telemetry
// failures must not create a second, now-unhandled application failure.
const captureModule = { exports: {} };
const captures = [];
const captureUnhandled = [];
const onCaptureUnhandled = error => captureUnhandled.push(error);
process.on('unhandledRejection', onCaptureUnhandled);
try {
  vm.runInNewContext(ts.transpileModule(monitoring, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, {
    module: captureModule, exports: captureModule.exports,
    process: { env: { EXPO_PUBLIC_SENTRY_DSN: 'https://public@example.test/1' } }, console,
    require: () => ({ init() {}, captureException(error) { captures.push(error); throw new Error('Capture transport failed'); } }),
  });
  const renderError = new Error('Private customer render fixture');
  captureModule.exports.captureRuntimeError(renderError);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(captures[0], renderError, 'React-caught errors reach the configured privacy-filtered SDK');
  assert.deepEqual(captureUnhandled, [], 'telemetry cannot turn a contained failure into a crash');
} finally {
  process.removeListener('unhandledRejection', onCaptureUnhandled);
}
console.log('React-caught runtime reporting cannot fail the application.');
