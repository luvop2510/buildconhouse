# Main release workflow

All completed application changes belong on `origin/main` in
`luvop2510/buildconhouse`. Main is the production source for Vercel. A worktree
or PR branch may isolate implementation and checks, but it is not a release source.

1. Fetch main and resolve `buildconhouse.in` through Vercel's alias API. Read the
   deployment by that exact ID, recording its source SHA. Never infer the live
   source from a project preview or a branch name. Start from main after ensuring
   it contains the live source. Reconcile discrepancies before unrelated work.
2. Make the complete change, including regression tests for shared callers.
   Preserve unfinished work in other checkouts. Do not copy entire older source
   trees over a newer release. Review each intended diff.
3. Validate a clean dependency install, TypeScript/lint, backend tests, frontend
   contracts, production export, browser regressions, required performance audit
   and vulnerability checks. UI tests use an immutable copy of the tested export;
   do not replace dependencies or export files while a runner uses them.
4. Push the integration branch and open a PR to main. The enforced independent
   approval and backend/frontend/frontend-security/performance checks must pass.
   Merge the PR, fetch main and use its exact final commit for deployment. Never
   manufacture checks or remove protections to make a release appear complete.
5. Production builds reject non-main Git branches. Promotion also checks that the
   candidate is the current remote-main commit and descends from the currently
   live frontend. A changed alias during verification stops promotion. Keep the
   existing authenticated, read-only, backend-binding and recovery checks.
6. Verify the canonical domain and backend runtime after publication and record
   deployment IDs/source/check results. Revoke only run-owned QA sessions.
   Retain a known rollback target. A deliberate rollback is an incident action,
   outside the normal forward-only release path; document it and reconcile main
   before resuming changes.

Do not delete a branch or worktree until its commits are contained in main and
its tracked/untracked work is reviewed or preserved in a recoverable snapshot.
After merging, the next change starts from refreshed main, not an earlier PR
checkout. A local pass, Git push, successful preview and production publication
are separate facts and must be reported separately.
