import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function blockingAdvisories(report) {
  if (report?.error || report?.auditReportVersion !== 2 ||
      !report.metadata?.vulnerabilities || !report.vulnerabilities ||
      typeof report.vulnerabilities !== "object" || Array.isArray(report.vulnerabilities)) {
    throw new Error("npm audit returned an invalid report; security status is unknown");
  }
  const findings = Object.entries(report.vulnerabilities);
  const counts = report.metadata.vulnerabilities;
  const severities = ["info", "low", "moderate", "high", "critical"];
  if ([...severities, "total"].some((severity) =>
    !Number.isSafeInteger(counts[severity]) || counts[severity] < 0) ||
    severities.reduce((sum, severity) => sum + counts[severity], 0) !== counts.total ||
    counts.total !== findings.length) {
    throw new Error("npm audit returned invalid advisory counts");
  }
  for (const [name, finding] of findings) {
    if (!finding || !severities.includes(finding.severity)) {
      throw new Error(`npm audit returned an invalid advisory for ${name}`);
    }
  }
  // Build dependencies are included: an advisory must be fixed, not waived by
  // package name. Keep this a separate blocking CI job so functional checks
  // still run and provide useful evidence when upstream fixes are unavailable.
  return findings.filter(([, finding]) => ["high", "critical"].includes(finding.severity));
}

export function runAudit() {
  const audit = spawnSync("npm", ["audit", "--json"], {
    encoding: "utf8", timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
  });
  try {
    if (audit.error || ![0, 1].includes(audit.status) || !audit.stdout) {
      throw new Error(audit.error?.message || audit.stderr || "npm audit did not complete");
    }
    const report = JSON.parse(audit.stdout);
    const blocking = blockingAdvisories(report);
    console.log("npm audit counts:", JSON.stringify(report.metadata.vulnerabilities));
    if (blocking.length) {
      console.error("Blocking npm advisories:");
      for (const [name, finding] of blocking) {
        const sources = (finding.via || []).filter((via) => typeof via === "object")
          .map((via) => via.url).filter(Boolean);
        console.error(`- ${name} (${finding.severity})${sources.length ? `: ${sources.join(", ")}` : ""}`);
      }
      return 1;
    }
    console.log("npm audit gate passed; no high or critical advisories");
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runAudit();
}
