# Kitchen delegation catalog repair

Kitchen navigation has nine stage pages while Team was offering shared registers
that Kitchen's navigation deliberately hides. Staff with only those unrelated grants
land on Access because those grants do not authorize the Kitchen workflow.

The stable kitchen_projects capability now appears as Kitchen workspace. Its page
names come from the same navigation inventory used by the app, with Kitchen's
stage inventory shared by navigation and API labels. Other permission groups also
display their current navigation labels. A new navigation destination without a
registered capability fails the delegation regression check.

The backend distinguishes assignable_floor_ids from historical floor_ids. Kitchen
shared-register grants remain readable, round-trip on save and explicitly revocable;
they are not offered for new assignments or silently promoted to Kitchen authority.
The frontend also filters correctly while an older backend is still running.

The nine Kitchen pages share one workspace capability, including new stage pages;
this is not independent per-stage authorization. Existing actions and floor isolation
are retained. Owners can grant Kitchen workspace to the intended delegate using
Team. No unspecified user's live grant was changed by this source repair.

Verification: 48 backend catalog/delegation/provisioning tests passed; 64 floor
revocation combinations and page/action/landing checks passed; manifest/navigation
and grant-preservation checks passed. TypeScript and focused ESLint passed.
Full performance and production publication results are separate release evidence.

Live backend observed during this repair: source 1c7e717d3ec0edc348439fb032406f395ee90ca8.
Earlier session-continuity fixes remain in the prepared source, but this observed
live revision predates them. Publication must retain required release checks.
