# Kitchen save reliability and mobile editing

User-reported failures: Kitchen saves/stage handoffs show generic internal-server
or unreachable-backend errors; Ground selection actions obscure address editing;
quotation still shows Design2 when Design3 is finalized; production approval UI
must be removed and quotation-to-Order must settle visibly.

## Evidence and causes

Production runtime traces captured two Kitchen file-transfer finish failures at
17:00–17:01UTC on29October. Both escaped as `httpx.ReadTimeout` from
`R2StorageDriver._domain_settings` after approximately11seconds. Independent
Cloudflare managed/custom visibility requests previously ran serially with
ten-second timeouts, and that transport error bypassed StorageError handling.
No missing migration was found in the preceding production readiness preflight.

Read-only inspection confirmed the affected project is at quotation, finalized
Design3 has complete private-file metadata, and historical Design2 has no selected
final PDF. Old quotation display preferred its saved Design2 ID. No file or
historical attachment is fabricated to fill that gap.

A live API check on29October at18:29UTC intentionally submitted stale versions
through Railway and the Vercel same-origin proxy. All six commands rejected409
in454–748ms. Before/after project version and timestamp were unchanged. These
checks establish current connectivity and conflict handling, not successful
business-save or physical-device latency.

## Changes

- Private-domain checks execute concurrently under a single five-second bound.
  Only simultaneous checks share an in-flight result; completed proof is never
  cached or reused after a provider outage/public-domain change. Provider errors
  are sanitized and Kitchen file operations return actionable503/Retry-After.
  Staged bytes and retry keys survive failures; immutable attachment/CAS checks
  and private-bucket enforcement remain.
- Current unbound quotations display and explicitly save the selected finalized
  design and exact PDF attachment. Order-bound historical relationships stay
  unchanged. A saved-basis notice explains an unsaved current-design change.
  Both frontend and backend require that explicit save before an unbound
  quotation can advance to Order against a newly finalized design.
- The production-entry manager control and transition requirement are removed,
  as explicitly requested. Pending approval counts cover closure only. Closure
  manager, customer approval, advance/order and design requirements remain.
  Existing policy documents resolve the new rule without history rewriting or
  a schema migration.
- Ground mobile actions occupy layout space when idle and reclaim that entire
  space during input. Android avoids a duplicate keyboard height adjustment.
  Inputs remain mounted, and scroll/focus ownership stays with the existing shell.
- Kitchen stage actions show a destination-specific progress indicator and
  release it after success/failure. The obsolete Project enquiry copy is removed.
- Both API clients start the existing 30-second deadline before credential/floor
  loading and settle even when native storage, fetch or body reads ignore abort.
  Late credentials cannot send a canceled write; all exits clean up listeners,
  timers and active controllers. No write is automatically replayed.

## Validation

Focused storage76tests pass, including actual ASGI failures, staged transfer
recovery, same-key retry/replay, cancellation and public-domain changes. Real
disposable-Mongo Kitchen integration passes53cases and9related cases; existing
fixtures are aligned to the current required address and two-month production
schedule. Production-approval/relationship unit subset passes156cases.
The new eight-case rendered keyboard regression passes Chromium and WebKit at
320px and landscape widths. The complete API contract passes controlled hung
credentials, transport/body stalls, cancellation, late results and ordinary
cache/context isolation. Live Design3 PDF first-part download returned200 with
its SHA256 verified; Design2 lacks a selected historical final PDF.

Final frozen-source development acceptance: all 80 selected check groups pass,
including the full 3,962-case backend unit suite, TypeScript and zero-warning
frontend lint. Production preflight verifies unchanged database/storage identities
and no pending migration. Four new forward-alignment cases cover both navigation
commands, rejection without writes, explicit-save recovery and order-bound
history. The unchanged request/hydration deadlines remain in force.

Full final-source release checks, rendered geometry, production identities and
hosted verification are recorded in the release receipt after publication.
Browser emulation cannot certify a physical Android keyboard; a native rebuild
is required for Android IME/window configuration to reach installed applications.
