# Focused checks during development

Use `node scripts/check-affected.mjs` from the repository root to see the checks
selected for the current staged, unstaged and untracked work. Documentation-only
edits need no business tests. Ignored generated output is excluded.

- `node scripts/check-affected.mjs --run` executes the selected local contracts.
- `node scripts/check-affected.mjs --base origin/main --run` also includes committed
  changes since the merge base with remote main.
- `node scripts/check-affected.mjs --run --force` reruns without local success reuse.
- `node scripts/check-affected.mjs --json` prints the plan and dependency counts.

The selector reads the existing package test commands, resolves local imports,
source-file references and directory/template prefixes, and follows their
transitive dependencies. It runs a parent contract once when that parent already
imports another selected test. TypeScript remains an application-wide check for
frontend source changes. Shared authorization, design tokens, layouts,
dependencies, configuration and unmapped changes use a conservative full local
contract selection with complete-source receipt fingerprints. A changed standalone
`test-*.mjs` regression also runs before it is registered in package scripts. Backend edits run the existing isolated full unit suite;
Python receipts are never reused. The optional `test:frontend-drift` diagnostic
requires an externally approved Forge route baseline and remains a dedicated npm
command; automatic checks do not manufacture or refresh that baseline. Its
comparison logic is unchanged. No test budgets or CI jobs are weakened.

Each check prints one PASS, REUSE or FAIL line. Full output stays in the ignored
`.cache/affected-checks/` directory; failures also print a short tail. This avoids
repeatedly loading large passing logs into an agent's conversation.

A successful frontend contract can be reused only while its command, transitive
source bytes, dependency lockfiles, Node version, platform, environment digest and
source inventory match. A new or removed source file invalidates receipts even
when the import spelling is unchanged. Tests that discover files dynamically or
launch subprocesses fingerprint the complete repository input inventory. Failed
checks are never reused. Source edits detected during execution reject the receipt
and require another run. Receipts are local feedback and must never be treated as
release evidence or uploaded to authorize promotion.

## Publication gate

Run focused checks after each related edit. Once the final source is ready, run
`npm run test:performance:audit` once, with the unchanged complete stability and
timing scenarios. Existing CI, migration checks, hosted read-only verification,
source ancestry and Vercel/Railway promotion evidence still apply. Backend,
authorization, shared-shell and workflow changes must not bypass them.

New pages still require a use-case-specific runtime test and rendered review at
phone, tablet and desktop widths. A dependency selector cannot prove untested
business behavior or visual quality. If a page is unmapped, the script deliberately
expands the selection until its intended contract is added to package scripts.

## Measured scope example

On the 29 October 2026 source inventory there are 77 registered local contract
entry points. A change confined to `KitchenAutosave.ts` selects seven contracts
plus TypeScript, instead of all 77 contracts and repeated browser runs. A prose
change selects zero checks. These are selection counts, not a claimed production
latency improvement. On the retained 28 October export, the separate 60-case timing
suite alone took 170.5 seconds; that historical evidence does not certify a newer
source revision.
