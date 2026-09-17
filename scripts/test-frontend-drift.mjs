import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const repoRoot = process.cwd();
const appRoot = resolve(repoRoot, "app");
const artifactRoot = process.env.FORGE_DRIFT_ARTIFACT_ROOT
  ? resolve(process.env.FORGE_DRIFT_ARTIFACT_ROOT)
  : null;
const baselinePath = process.env.FORGE_ROUTE_BASELINE
  ? resolve(process.env.FORGE_ROUTE_BASELINE)
  : artifactRoot
    ? join(artifactRoot, "state/forge-route-baseline.json")
    : null;
const shouldWriteArtifacts = process.argv.includes("--write-artifacts") || process.env.FORGE_DRIFT_WRITE_ARTIFACTS === "1";

function filesIn(directory, predicate) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesIn(path, predicate) : predicate(path) ? [path] : [];
  });
}

function routeFromFile(file) {
  const relativePath = relative(appRoot, file).split(sep).join("/");
  if (!relativePath.endsWith(".tsx") || relativePath.includes("/") && /\/(?:_|\+)/.test(relativePath)) return null;
  if (relativePath.startsWith("_") || relativePath.startsWith("+")) return null;
  const route = relativePath
    .replace(/\.tsx$/, "")
    .replace(/\([^/]+\)\//g, "")
    .replace(/(^|\/)index$/, "")
    .replace(/\/\[\.\.\.(.+?)\]/g, "/*$1")
    .replace(/\[([^\]]+)\]/g, ":$1");
  return `/${route}`.replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function routeGroup(route) {
  if (["/", "/privacy", "/terms"].includes(route)) return "public";
  if (["/login", "/set-new-password"].includes(route)) return "auth";
  if (route === "/home" || route.startsWith("/quotes")) return "customer";
  return "admin";
}

function read(path) {
  return readFileSync(path, "utf8");
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function collectRoutes() {
  return filesIn(appRoot, (path) => path.endsWith(".tsx"))
    .map((file) => ({ file: relative(repoRoot, file).split(sep).join("/"), route: routeFromFile(file) }))
    .filter((entry) => entry.route)
    .sort((a, b) => a.route.localeCompare(b.route) || a.file.localeCompare(b.file));
}

function collectMetrics(routes) {
  const routeSource = routes.map((entry) => ({ ...entry, text: read(resolve(repoRoot, entry.file)) }));
  const componentSource = filesIn(resolve(repoRoot, "src"), (path) => /\.(?:ts|tsx)$/.test(path))
    .map((file) => ({ file: relative(repoRoot, file).split(sep).join("/"), text: read(file) }))
    .filter((entry) => !/(?:design|theme)\/tokens\.ts$/.test(entry.file));
  const designImports = /from\s+["']@\/src\/(?:design|components\/(?:ui|ds))["']/;
  return {
    routeFiles: routeSource.length,
    routeFilesWithSharedDesignImport: routeSource.filter((entry) => designImports.test(entry.text)).length,
    routeFilesWithLiteralColors: routeSource.filter((entry) => /#[0-9a-f]{6}\b/i.test(entry.text)).length,
    routeFilesWithInlineFontFamily: routeSource.filter((entry) => /fontFamily\s*:/.test(entry.text)).length,
    routeFilesWithLocalStyleSheet: routeSource.filter((entry) => /StyleSheet\.create\s*\(/.test(entry.text)).length,
    componentFilesWithLiteralColors: componentSource.filter((entry) => /#[0-9a-f]{6}\b/i.test(entry.text)).length,
    componentFilesWithInlineFontFamily: componentSource.filter((entry) => /fontFamily\s*:/.test(entry.text)).length,
    pressablesWithoutAccessibleName: routeSource.reduce((total, entry) => total + [...entry.text.matchAll(/<Pressable\b[^>]*>/g)]
      .filter(([tag]) => !/(accessibilityLabel|accessibilityRole|testID)=/.test(tag)).length, 0),
    routesWithRecoveryLanguage: routeSource.filter((entry) => /(retry|try again|error|unavailable|loading|empty|no results)/i.test(entry.text)).length,
    routesWithSearchOrEntry: routeSource.filter((entry) => /(SearchField|TextInput|search|onChangeText|FormField)/i.test(entry.text)).length,
  };
}

function requiredFiles() {
  return [
    "src/design/tokens.ts",
    "src/design/controls.tsx",
    "src/design/forms.tsx",
    "src/design/feedback.tsx",
    "src/design/Overlay.tsx",
    "src/design/PageHeader.tsx",
    "src/design/Screen.tsx",
    "src/design/responsive.ts",
  ];
}

function currentSnapshot() {
  const routes = collectRoutes();
  const metrics = collectMetrics(routes);
  let commit = "working-tree";
  try {
    commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {}
  return {
    schema: 1,
    generatedAt: new Date().toISOString(),
    sourceCommit: commit,
    routeCount: routes.length,
    routes: routes.map(({ file, route }) => ({ file, route, group: routeGroup(route) })),
    metrics,
    requiredFiles: requiredFiles().filter((file) => existsSync(resolve(repoRoot, file))),
    sourceFingerprints: Object.fromEntries(routes.map((entry) => [entry.file, sha256(read(resolve(repoRoot, entry.file)))])),
  };
}

function statusForMetric(current, baseline, key, direction = "lower") {
  if (baseline === undefined) return "new";
  if (direction === "higher") return current >= baseline ? "pass" : "regressed";
  return current <= baseline ? "pass" : "regressed";
}

function shellCommand(...lines) {
  return lines.join(" \\\n");
}

function routeInventoryMarkdown(snapshot) {
  const groups = ["public", "auth", "customer", "admin"];
  const rows = groups.flatMap((group) => snapshot.routes.filter((route) => route.group === group)
    .map((route) => `| ${group} | \`${route.route}\` | \`${route.file}\` |`));
  return `# Forge 2.0 Route Inventory\n\nGenerated from the canonical root Expo app. This is a structural inventory, not proof that every business branch has live data.\n\n- Route modules: **${snapshot.routeCount}**\n- Source commit: \`${snapshot.sourceCommit}\`\n- Generated: ${snapshot.generatedAt}\n\n| Group | Route | Module |\n| --- | --- | --- |\n${rows.join("\n")}\n`;
}

function scorecardMarkdown(snapshot, baseline) {
  const current = snapshot.metrics;
  const previous = baseline?.metrics || {};
  const rows = [
    ["Hierarchy", "Shared design import coverage", current.routeFilesWithSharedDesignImport, previous.routeFilesWithSharedDesignImport, "higher"],
    ["Harmony", "Route files with literal colors", current.routeFilesWithLiteralColors, previous.routeFilesWithLiteralColors, "lower"],
    ["Harmony", "Shared component files with literal colors", current.componentFilesWithLiteralColors, previous.componentFilesWithLiteralColors, "lower"],
    ["Consistency", "Route files with inline font families", current.routeFilesWithInlineFontFamily, previous.routeFilesWithInlineFontFamily, "lower"],
    ["Consistency", "Shared component files with inline font families", current.componentFilesWithInlineFontFamily, previous.componentFilesWithInlineFontFamily, "lower"],
    ["Consistency", "Route files with local StyleSheet", current.routeFilesWithLocalStyleSheet, previous.routeFilesWithLocalStyleSheet, "lower"],
    ["Accessibility", "Pressables without accessible name/test ID", current.pressablesWithoutAccessibleName, previous.pressablesWithoutAccessibleName, "lower"],
    ["Adaptability", "Route modules in responsive app surface", current.routeFiles, previous.routeFiles, "higher"],
    ["Feedback", "Routes with recovery/loading/empty language", current.routesWithRecoveryLanguage, previous.routesWithRecoveryLanguage, "higher"],
    ["Search + entry", "Routes with search or data-entry signals", current.routesWithSearchOrEntry, previous.routesWithSearchOrEntry, "higher"],
  ];
  const table = rows.map(([principle, measure, value, base, direction]) => `| ${principle} | ${measure} | ${value} | ${base ?? "—"} | ${statusForMetric(value, base, measure, direction)} |`).join("\n");
  return `# Forge 2.0 HIG Scorecard\n\nThis scorecard turns Apple HIG-inspired principles into repeatable repository signals. It is a drift guard, not an Apple certification or a substitute for native/device review.\n\n| Principle | Measure | Current | Baseline | Status |\n| --- | --- | ---: | ---: | --- |\n${table}\n\n## Interpretation\n\n- Hierarchy and harmony are protected by shared token/component coverage and a no-new-literal-colors rule.\n- Accessibility is a static smoke signal; Playwright separately checks visible labels, focus, clipping, and overflow.\n- Adaptability and feedback are coverage signals. They do not certify every data state or native text-size setting.\n\n## Rubric sources\n\n- [Apple design principles](https://developer.apple.com/design/human-interface-guidelines/design-principles)\n- [Apple HIG patterns](https://developer.apple.com/design/human-interface-guidelines/patterns)\n- [Generative UI and design-system drift](https://f1studioz.com/blog/generative-ui-what-happens-to-your-design-system-when-the-interface-builds-itself/)\n- [AI-generated UI drift](https://bezel.new/blog/your-ai-generated-ui-is-already-out-of-date)\n`;
}

function setupMarkdown() {
  const root = artifactRoot || "/absolute/path/to/heyclicky/agents/buildcon-buddy";
  const baseline = baselinePath || `${root}/state/forge-route-baseline.json`;
  const visual = artifactRoot ? join(artifactRoot, "output/forge-visual-baselines") : `${root}/output/forge-visual-baselines`;
  return [
    "# Forge 2.0 Drift Gate Setup",
    "",
    "The gate is frontend-only. It does not start a backend, call production APIs, or modify product behavior.",
    "",
    "## Static gate",
    "",
    "From the Forge repository:",
    "",
    "```sh",
    shellCommand(
      `FORGE_DRIFT_ARTIFACT_ROOT="${root}"`,
      `FORGE_ROUTE_BASELINE="${baseline}"`,
      "npm run test:frontend-drift",
    ),
    "```",
    "",
    "It fails when route paths or fingerprinted route source change, required design-system files disappear, or static drift metrics get worse than the saved baseline.",
    "",
    "## Refresh after an intentional redesign",
    "",
    "```sh",
    shellCommand(
      `FORGE_DRIFT_ARTIFACT_ROOT="${root}"`,
      "FORGE_DRIFT_WRITE_ARTIFACTS=1",
      "node scripts/test-frontend-drift.mjs --write-artifacts",
    ),
    "```",
    "",
    "Only refresh the baseline after a human reviews the visual change and confirms it is intentional.",
    "",
    "## Browser gate",
    "",
    "After building the safe static export expected by the existing audit server:",
    "",
    "```sh",
    shellCommand(
      `FORGE_ROUTE_BASELINE="${baseline}"`,
      `FORGE_DRIFT_VISUAL_DIR="${visual}"`,
      "npm run test:frontend-drift:browser",
    ),
    "```",
    "",
    "The browser gate checks the saved route inventory at desktop and phone sizes for unmatched routes, runtime errors, horizontal overflow, heading clipping, and accessible interactive names. It captures a small set of critical route baselines when a visual directory is provided.",
    "",
    "## Scope limits",
    "",
    "The gate does not validate live backend data, financial calculations, native VoiceOver/TalkBack behavior, browser zoom certification, or production deployment state.",
    "",
  ].join("\n");
}

function writeArtifacts(snapshot, baseline) {
  if (!artifactRoot) throw new Error("Set FORGE_DRIFT_ARTIFACT_ROOT before writing Clicky artifacts.");
  const outputRoot = join(artifactRoot, "output");
  const stateRoot = join(artifactRoot, "state");
  const visualRoot = join(outputRoot, "forge-visual-baselines");
  for (const directory of [outputRoot, stateRoot, visualRoot]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(outputRoot, "forge-route-inventory.md"), routeInventoryMarkdown(snapshot));
  writeFileSync(join(outputRoot, "forge-hig-scorecard.md"), scorecardMarkdown(snapshot, baseline));
  writeFileSync(join(outputRoot, "forge-drift-gate-setup.md"), setupMarkdown());
  writeFileSync(join(visualRoot, "README.md"), [
    "# Forge Visual Baselines",
    "",
    "This directory is reserved for deterministic critical-route captures produced by `npm run test:frontend-drift:browser`.",
    "",
    "The browser gate currently captures dashboard, customers, follow-ups, quotations, tile orders, and settings at desktop and phone sizes. Structural assertions remain the blocking check; screenshots are review evidence and should be refreshed only after an intentional visual change.",
    "",
  ].join("\n"));
  writeFileSync(join(stateRoot, "forge-route-baseline.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
}

function compare(snapshot, baseline) {
  const failures = [];
  const currentRoutes = snapshot.routes.map((route) => route.route);
  const baselineRoutes = baseline?.routes?.map((route) => route.route) || [];
  const added = currentRoutes.filter((route) => !baselineRoutes.includes(route));
  const removed = baselineRoutes.filter((route) => !currentRoutes.includes(route));
  if (added.length || removed.length) failures.push(`route inventory changed (added: ${added.join(", ") || "none"}; removed: ${removed.join(", ") || "none"})`);
  const baselineFingerprints = baseline?.sourceFingerprints || {};
  for (const route of snapshot.routes) {
    const previousFingerprint = baselineFingerprints[route.file];
    const currentFingerprint = snapshot.sourceFingerprints[route.file];
    if (previousFingerprint && currentFingerprint !== previousFingerprint) {
      failures.push(`route source changed and needs visual review: ${route.file}`);
    }
  }
  for (const file of requiredFiles()) if (!existsSync(resolve(repoRoot, file))) failures.push(`required design-system file is missing: ${file}`);
  const current = snapshot.metrics;
  const previous = baseline?.metrics || {};
  const checks = [
    ["routeFilesWithLiteralColors", "literal-color route files", "lower"],
    ["routeFilesWithInlineFontFamily", "inline-font route files", "lower"],
    ["componentFilesWithLiteralColors", "literal-color component files", "lower"],
    ["componentFilesWithInlineFontFamily", "inline-font component files", "lower"],
    ["routeFilesWithLocalStyleSheet", "local StyleSheet route files", "lower"],
    ["pressablesWithoutAccessibleName", "unnamed Pressables", "lower"],
    ["routeFilesWithSharedDesignImport", "shared design import coverage", "higher"],
    ["routesWithRecoveryLanguage", "recovery-language coverage", "higher"],
  ];
  for (const [key, label, direction] of checks) {
    const status = statusForMetric(current[key], previous[key], key, direction);
    if (status === "regressed") failures.push(`${label} drifted from ${previous[key]} to ${current[key]}`);
  }
  return failures;
}

const snapshot = currentSnapshot();
const baseline = baselinePath && existsSync(baselinePath) ? JSON.parse(read(baselinePath)) : null;
if (shouldWriteArtifacts) writeArtifacts(snapshot, baseline);
if (!baseline) {
  if (shouldWriteArtifacts) {
    console.log(`Forge route baseline initialized at ${baselinePath || "the artifact root"}.`);
    process.exit(0);
  }
  console.error("No Forge route baseline found. Run with FORGE_DRIFT_WRITE_ARTIFACTS=1 --write-artifacts first.");
  process.exit(2);
}
const failures = compare(snapshot, baseline);
console.log(`Forge frontend drift gate: ${snapshot.routeCount} route modules checked`);
console.log(`Route baseline: ${baselinePath}`);
console.log(`Metrics: ${JSON.stringify(snapshot.metrics)}`);
if (failures.length) {
  console.error("Drift gate failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("Drift gate passed: no route, design-system, or regression-metric drift detected.");
