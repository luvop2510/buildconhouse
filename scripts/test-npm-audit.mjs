import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { blockingAdvisories } from "./check-npm-audit.mjs";

const report = (vulnerabilities = {}) => {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const finding of Object.values(vulnerabilities)) {
    counts[finding.severity] += 1;
    counts.total += 1;
  }
  return { auditReportVersion: 2, metadata: { vulnerabilities: counts }, vulnerabilities };
};

assert.deepEqual(blockingAdvisories(report()), []);
assert.deepEqual(blockingAdvisories(report({ decoder: { severity: "moderate" } })), []);
assert.deepEqual(blockingAdvisories(report({
  expo: { severity: "high" },
  "node-forge": { severity: "high" },
  unknown: { severity: "critical" },
})).map(([name]) => name), ["expo", "node-forge", "unknown"]);

// A registry outage returns valid JSON with an error object; that must never
// be mistaken for an empty, clean audit (the previous gate did so).
for (const invalid of [
  { error: { code: "ENOAUDIT" } },
  { auditReportVersion: 2 },
  {},
  null,
  report([]),
  report({ package: {} }),
  { ...report(), metadata: { vulnerabilities: {} } },
]) {
  assert.throws(() => blockingAdvisories(invalid), /invalid/);
}

const bin = mkdtempSync(join(tmpdir(), "forge-npm-audit-test-"));
try {
  const gate = fileURLToPath(new URL("./check-npm-audit.mjs", import.meta.url));
  for (const [body, npmStatus, gateStatus] of [
    [JSON.stringify(report()), 0, 0],
    [JSON.stringify(report({ expo: { severity: "high" } })), 1, 1],
    [JSON.stringify({ error: { code: "ENOAUDIT" } }), 1, 1],
    ["registry temporarily unavailable", 1, 1],
    [JSON.stringify(report()), 2, 1],
  ]) {
    writeFileSync(join(bin, "npm"),
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(body)}); process.exit(${npmStatus});\n`,
      { mode: 0o755 });
    const result = spawnSync(process.execPath, [gate], {
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` }, encoding: "utf8",
    });
    assert.equal(result.status, gateStatus, result.stdout + result.stderr);
  }
} finally {
  rmSync(bin, { recursive: true, force: true });
}
console.log("npm audit gate: high/critical build findings block; incomplete reports fail closed");
