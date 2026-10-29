# Kitchen intake, Today and blue accents — 29 October 2026

Kitchen Add Lead now collects customer name, phone and address as required
customer fields. The user's latest correction removes Site location entirely
from lead entry, its list column, required policies and draft-save prerequisites.
Property/site name, city, state, PIN code, email, alternate phone, company, GST
and customer notes are also removed from intake. Historical customer data remains
stored. Existing customers must have an address before creating another lead;
the shared customer directory remains the place to correct their contact data.
Server creation validates address before inserting a new inline customer and
validates an existing/reused customer's address before project creation. Existing
successful idempotent replays and historical project edits stay compatible.
Stored historical site locations remain available to the compatible API/search;
no database field is deleted or rewritten.

Kitchen uses the existing `/dashboard` Today workspace. Today is visible in the
Kitchen sidebar and phone navigation. Employee tasks match the project's current
assigned worker and retain stage permissions and exact Kitchen floor scope.
Owner/admin/manager views retain their existing floor-wide responsibility.
Assignment changes move the task between workers without changing business data.
Lost, paused, archived and completed projects do not become open tasks.

The original blue accent comes from the palette before commit `a05d7c73`:
`#0066CC`, hover `#004F9F`, tint `#EAF2FF`, border `#BED6F7`.
White surfaces, graphite text, system typography and semantic status colors
remain. Shared actions, selection, focus and analytics accents consume the same
roles. Blue on white measures 5.57:1; blue on its tint measures 4.94:1.

No dependency, database migration or new architectural layer is introduced.
Implementation and release checks are recorded in the accompanying release
receipt under the parent workspace's `outputs/kitchen-flow-2026-10-29/`.
Browser emulation does not certify physical devices or universal production
latency. Publication must verify GitHub main and actual Vercel/Railway identities.
