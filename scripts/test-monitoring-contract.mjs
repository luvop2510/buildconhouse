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
