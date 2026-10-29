import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const normalize = path => path.replaceAll('\\', '/');
const sourceFile = file => /\.(?:[cm]?[jt]sx?|json|ya?ml)$/.test(file);
const documentation = file => /^(?:memory\/|\.claude\/)|\.(?:md|txt)$|^docs\/.*\.pdf$/.test(file);
const shared = file => /^(?:package(?:-lock)?\.json|(?:tsconfig|metro\.config|babel\.config|app\.config|expo-env\.).*|\.github\/|src\/(?:state|theme|design)\/|src\/(?:api\/client|hooks\/use-(?:permissions|floor-access))\.|app\/(?:_layout|\(admin\)\/_layout))/.test(file);
const ignored = file => /^(?:output|dist|node_modules|\.cache|tmp)\//.test(file);
const digest = value => createHash('sha256').update(value).digest('hex');
const git = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).split('\0').filter(Boolean);

export function changedFiles(root, base) {
  const changed = git(root, ['diff', '--name-only', '-z', 'HEAD']);
  if (base) {
    assert.ok(!base.startsWith('-'), 'Base must be a Git revision');
    const revision = execFileSync('git', ['rev-parse', '--verify', `${base}^{commit}`], { cwd: root, encoding: 'utf8' }).trim();
    changed.push(...git(root, ['diff', '--name-only', '-z', `${revision}...HEAD`]));
  }
  return [...new Set([...changed, ...git(root, ['ls-files', '--others', '--exclude-standard', '-z'])])].map(normalize).filter(file => !ignored(file)).sort();
}

export function createGraph(root, files) {
  const known = new Set(files), graph = new Map();
  graph.unbounded = new Set();
  const candidates = value => [value, ...['.ts', '.tsx', '.web.ts', '.web.tsx', '.native.ts', '.native.tsx', '.js', '.mjs', '.cjs', '.json'].flatMap(extension => [`${value}${extension}`, `${value}/index${extension}`])];
  const paths = (file, value, directory = false) => {
    if (!value || value.includes('\n') || value.includes('://')) return [];
    const roots = value.startsWith('@/') ? [value.slice(2)] : value.startsWith('.') ? [normalize(relative(root, resolve(root, dirname(file), value)))] : [value];
    return roots.flatMap(path => directory ? files.filter(candidate => candidate !== file && !candidate.startsWith('scripts/') && (path === '' || candidate.startsWith(`${path.replace(/\/$/, '')}/`))) : candidates(path).filter(candidate => known.has(candidate)));
  };
  for (const file of files) {
    const dependencies = new Set();
    if (!sourceFile(file) || !existsSync(resolve(root, file))) { graph.set(file, dependencies); continue; }
    const source = readFileSync(resolve(root, file), 'utf8');
    const directoryReader = /\breaddir\w*\s*\(/.test(source);
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isStringLiteralLike(node)) {
        for (const path of paths(file, node.text)) if (path !== file) dependencies.add(path);
        if (directoryReader) for (const path of paths(file, node.text, true)) dependencies.add(path);
      }
      if (ts.isTemplateExpression(node)) {
        const prefix = node.head.text;
        if (prefix.includes('/')) for (const path of paths(file, prefix.slice(0, prefix.lastIndexOf('/') + 1), true)) dependencies.add(path);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
    // Directory walkers and generated path names cannot be bounded by imports.
    // Their receipts include the whole source inventory instead of guessing.
    if (/\b(?:readdir|glob|execFile|spawn|execSync)\w*\s*\(/.test(source) || /(?:readFile|access|stat)\w*\([^\n]*`[^`]*\$\{/.test(source)) graph.unbounded.add(file);
    graph.set(file, dependencies);
  }
  return graph;
}

export function closure(graph, start) {
  const visited = new Set();
  const visit = file => { if (visited.has(file)) return; visited.add(file); for (const child of graph.get(file) || []) visit(child); };
  visit(start);
  return visited;
}

export function contractCommands(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  const commands = new Map();
  for (const [name, command] of Object.entries(pkg.scripts || {})) {
    // This optional diagnostic requires an externally approved route baseline.
    if (!name.startsWith('test:') || name === 'test:frontend-drift' || /^test:(?:e2e|performance:audit|mobile-budget)/.test(name)) continue;
    for (const part of command.split(/\s*&&\s*/)) {
      const match = part.match(/^node\s+((?:--[\w-]+\s+)*)((?:scripts\/)[\w/-]+\.[cm]?js)$/);
      if (match) commands.set(match[2], ['node', ...match[1].trim().split(/\s+/).filter(Boolean), match[2]]);
    }
  }
  for (const file of ['scripts/test-check-affected.mjs', 'scripts/test-design-contrast.mjs', 'scripts/verify-tile-orders-contract.mjs']) {
    if (existsSync(resolve(root, file))) commands.set(file, ['node', file]);
  }
  return commands;
}

export function affectedPlan(root, changed, { files, commands } = {}) {
  const relevant = changed.filter(file => !documentation(file) && !ignored(file));
  if (!relevant.length) return { changed, relevant, uncovered: [], broad: false, checks: [], releaseRequired: false };
  files ||= [...new Set(git(root, ['ls-files', '-z']).concat(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])))].filter(file => !ignored(file) && !documentation(file));
  commands = new Map(commands || contractCommands(root));
  for (const file of relevant) if (/^scripts\/test-[\w-]+\.mjs$/.test(file) && existsSync(resolve(root, file)) && !commands.has(file)) commands.set(file, ['node', '--experimental-strip-types', '--no-warnings', file]);
  const graph = createGraph(root, files), dependencies = new Map([...commands.keys()].map(file => [file, closure(graph, file)]));
  const frontend = relevant.filter(file => !file.startsWith('backend/'));
  const backend = relevant.some(file => file.startsWith('backend/'));
  const uncovered = frontend.filter(file => ![...dependencies.values()].some(inputs => inputs.has(file)));
  const broad = frontend.some(shared) || uncovered.length > 0;
  let selected = [...commands.keys()].filter(file => frontend.length && (broad || frontend.some(changedFile => dependencies.get(file).has(changedFile))));
  // A script imported by another selected script is already executed there.
  selected = selected.filter(file => !selected.some(other => other !== file && dependencies.get(other).has(file) && !dependencies.get(file).has(other)));
  const checks = selected.sort().map(file => ({ id: file, command: commands.get(file), inputs: broad || [...dependencies.get(file)].some(input => graph.unbounded.has(input)) ? files : [...dependencies.get(file)].sort(), unbounded: broad || [...dependencies.get(file)].some(input => graph.unbounded.has(input)), cwd: '.' }));
  if (frontend.some(file => /\.[jt]sx?$/.test(file) || shared(file))) checks.push({ id: 'typescript', command: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'], inputs: files.filter(file => /\.(?:ts|tsx|json)$/.test(file)), cwd: '.' });
  if (backend) checks.push({ id: 'backend-unit', command: ['backend/.venv/bin/python', '-m', 'pytest', 'tests/unit', '-q'], inputs: files.filter(file => file.startsWith('backend/')), cwd: 'backend' });
  return { changed, relevant, uncovered, broad, checks, releaseRequired: relevant.length > 0 };
}

export function fingerprint(root, check) {
  const inventory = [...new Set(git(root, ['ls-files', '-z']).concat(git(root, ['ls-files', '--others', '--exclude-standard', '-z'])))].filter(file => !ignored(file) && !documentation(file)).sort();
  const files = [...new Set([...(check.unbounded ? inventory : check.inputs), 'package.json', 'package-lock.json', 'tsconfig.json', 'node_modules/.package-lock.json', 'scripts/check-affected.mjs'])].sort();
  const values = files.map(file => `${file}\0${existsSync(resolve(root, file)) ? digest(readFileSync(resolve(root, file))) : 'missing'}`);
  return digest(JSON.stringify({ command: check.command, cwd: check.cwd, node: process.version, platform: process.platform, arch: process.arch, environment: Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b)), inventory, values }));
}

export function runPlan(root, plan, { force = false, run = spawnSync } = {}) {
  const cache = resolve(root, '.cache/affected-checks'); mkdirSync(cache, { recursive: true });
  let passed = 0, reused = 0, failed = 0;
  for (const check of plan.checks) {
    const before = fingerprint(root, check), receipt = resolve(cache, `${digest(check.id)}.json`);
    let saved; try { saved = JSON.parse(readFileSync(receipt, 'utf8')); } catch {}
    if (!force && check.id !== 'backend-unit' && saved?.fingerprint === before && saved?.passed === true) { console.log(`REUSE ${check.id}`); reused++; continue; }
    const started = performance.now();
    const [executable, ...args] = check.command;
    const command = executable === 'node' ? process.execPath : resolve(root, executable);
    const isolated = { ...process.env, PYTHON_DOTENV_DISABLED: '1', MONGO_URL: 'mongodb://localhost:27017', DB_NAME: 'forge_ci_unit_tests', JWT_SECRET: 'ci-unit-test-secret-not-a-real-secret-32chars', JWT_ALGORITHM: 'HS256', JWT_EXP_MINUTES: '43200', MEDIA_STORAGE_DRIVER: 'supabase', SUPABASE_URL: 'https://ci-placeholder.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'ci-placeholder-not-real', SUPABASE_ANON_KEY: 'ci-placeholder-not-real', SUPABASE_PUBLIC_BUCKET: 'forge-products', SUPABASE_PRIVATE_BUCKET: 'forge-private', FORGE_ALLOW_DEMO_SEED: 'false', ENVIRONMENT: 'production' };
    const result = run(command, args, { cwd: resolve(root, check.cwd), env: check.id === 'backend-unit' ? isolated : process.env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    const log = resolve(cache, `${digest(check.id)}.log`);
    writeFileSync(log, `${result.stdout || ''}${result.stderr || ''}${result.error ? `\n${result.error.message}` : ''}`);
    const unchanged = fingerprint(root, check) === before;
    const ok = result.status === 0 && !result.error && unchanged;
    writeFileSync(receipt, JSON.stringify({ fingerprint: before, passed: ok, checkedAt: new Date().toISOString() }) + '\n');
    console.log(`${ok ? 'PASS' : 'FAIL'} ${check.id} (${((performance.now() - started) / 1000).toFixed(1)}s)${unchanged ? '' : ' — inputs changed during execution; rerun required'}`);
    if (ok) passed++; else { failed++; console.error(`${relative(root, log)}\n${readFileSync(log, 'utf8').slice(-5000)}`); }
  }
  console.log(`Affected checks: ${passed} passed, ${reused} reused, ${failed} failed. Full logs: .cache/affected-checks/`);
  return { passed, reused, failed };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), baseIndex = args.indexOf('--base');
    assert.ok(args.every((arg, i) => ['--run', '--force', '--json', '--base'].includes(arg) || i === baseIndex + 1 && baseIndex >= 0), 'Use --run, --force, --json or --base <revision>');
    if (baseIndex >= 0) assert.ok(args[baseIndex + 1] && !args[baseIndex + 1].startsWith('-'), '--base requires a revision');
    const root = process.cwd(), plan = affectedPlan(root, changedFiles(root, baseIndex >= 0 ? args[baseIndex + 1] : undefined));
    if (args.includes('--json')) console.log(JSON.stringify({ ...plan, checks: plan.checks.map(({ inputs, ...check }) => ({ ...check, inputCount: inputs.length })) }, null, 2));
    else { console.log(`${plan.relevant.length} code/config changes; ${plan.checks.length} affected checks${plan.broad ? ' (conservative shared/unmapped fallback)' : ''}.`); for (const check of plan.checks) console.log(`  ${check.id}`); }
    if (args.includes('--run')) process.exitCode = runPlan(root, plan, { force: args.includes('--force') }).failed ? 1 : 0;
    if (!args.includes('--json') && plan.releaseRequired) console.log('Development feedback only. Before publication run the unchanged full release/performance gate once on final source: npm run test:performance:audit');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
