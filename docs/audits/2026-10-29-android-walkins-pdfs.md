# Android intake and portrait PDF update — 29 October 2026

## Scope and design review

Buildcon House is a showroom work app for staff using Ground, Sanitary Bathroom and Furniture floors. Intake has one job: record a visitor and assign the interested floors. The requested Apple design principles apply to readability, hierarchy, touch targets and responsive layout; Android keeps its native input behavior.

Source findings: native Android inputs allowed fullscreen IME extraction; hidden native bottom navigation retained height; web reveal repeatedly read layout and wrote unchanged scroll positions; the walk-in register requested its summary on every search character. The intake exposed extra contact/referral/project fields ahead of the task. PDF pages and customer metadata did not provide the requested portrait/readable layout. The user clarified that the page must be portrait A4 while product photos are landscape and the original eleven quotation columns remain unchanged; the final table retains those exact columns/order, with no stacked Rates block.

The existing interface tokens remain authoritative: canvas #F5F5F7, white surfaces, #1D1D1F primary text (16.8:1 on white), #545458 secondary text (7.6:1), #0066CC actions (5.57:1), #E2E2E7 separators. System type, 16px mobile inputs, 24px phone titles, 16px gutters and 44–48px controls use existing shared components. The established light theme remains the current theme; this change does not claim a verified dark theme.

The signature stays the quiet showroom register with recognisable customer identity and floor/team assignment. A generic decorative card layer would compete with that job, so the form reuses existing fields, disclosure and action styles. No decorative motion is introduced.

Compact and regular layout use the same reading order, with regular content bounded to 720px:

```text
Compact phone             Regular width
[Shared app header]       [Shared app header]
[Back  Log Walk-in]          [Back  Log Walk-in      ]
[Name             ]         [Name                  ]
[Phone            ]         [Phone                 ]
[Address*         ]         [Address*              ]
[Floor / team     ]         [Floor / team          ]
[Lead source  >   ]         [Lead source       >   ]
[Log Walk-in      ]         [Log Walk-in           ]
```

Address is required by the user’s explicit clarification. Removed fields remain in historical records. New intake retains duplicate resolution and floor/worker admission. Commercial/financial operations remain explicit. The user supplied IMG_4083.PNG and specifically requested Verantes Living beside Vitra, retaining existing variants.

Apple references read: `layout.md › Visual hierarchy`: “Use progressive disclosure to make layouts cleaner and easier to interact with.” `accessibility.md › Mobility`: “Offer sufficiently sized controls.” `text-fields.md`, `entering-data.md`, `virtual-keyboards.md`, `typography.md`, `color.md`, `designing-for-ios.md`, `loading.md`, plus `cross-platform.md` inform the React Native translation. Native fullscreen behavior follows [React Native TextInput](https://reactnative.dev/docs/textinput#disablefullscreenui); Android Chrome viewport configuration follows [Chrome documentation](https://developer.chrome.com/blog/viewport-resize-behavior/).

## Data and release boundaries

No new collection, destructive backfill, dependency or migration is required. Existing data and runtime storage bindings remain. Read-only production preflight found no pending migrations. The initial canonical Vercel deployment is dpl_C45RXUhCnpDEBAsNpVgv1p6v2cSn at GitHub main 54d3146a9206723b6794c312634b57b711a04cfe; actual alias and provider metadata were queried. Existing dirty work in the main checkout is preserved in place; implementation uses an isolated checkout of remote main.

Native IME/default/window changes require a rebuilt Android application. Browser emulation and unsigned exports cannot certify a physical Android keyboard or device performance.

## Ground Floor walk-in reuse

The user additionally requested exact walk-in details when selecting an existing name for a selection or quotation. The editor previously searched only the newest 500 local customer records and copied name/phone while ignoring address (and retaining an old phone when the selected person had none). The fix uses bounded literal server search, explicit customer-ID selection, saved contact/address/referrer hydration and stale-response guards. Existing Customers directory confirmation rules and selected-floor grants remain. Document dates/numbers and current staff fields remain document-specific.

## Verification

Rendered regression matrix: 66 checks passed across desktop, tablet and phone, including exact same-name customer selection and phone/address snapshots in both selection and quotation. Focused tile lifecycle has 40 passing regressions, including remote-creation suspension during name lookup. Native save tests assert exact attachment basename and removal of each private preparation directory; browser/portal filenames honor authenticated Content-Disposition, including Unicode customer names. The supplied logo is included in the runtime image assets. Sample documents were rasterized and inspected for all three covers/detail pages; original eleven quotation columns remain ordered, and page media boxes are portrait A4.

Publication identities and full final release-gate results follow after execution. Deterministic visible-typing probe over 1,000 keystrokes reduced computed-style reads from 4,000 to 2,000, geometry reads from 6,000 to 3,000 and unchanged scroll writes from 2,000 to zero. These operation counts are not a latency claim.

Final independent review identified and resolved two additional cases: the name lookup now owns its autosave gate, cancels delayed blur and releases ownership on unmount/rotation; logging an explicitly linked or high-confidence existing customer now preserves the newly entered nonblank address through an exact customer/floor profile update and before/after activity audit. Missing/blank legacy addresses never erase the profile. Independent re-review accepted the focus fix; 45 focused walk-in/address cases passed. Two earlier full backend reruns under concurrent build/browser load each exceeded the unchanged 300ms outer deadline in a different existing Kitchen hydration test; the isolated six-case diagnostic passed with 50–60ms calls. Final full backend acceptance is executed without competing build/browser work; no timeout or security gate is changed.

Final isolated backend acceptance: 3,940 passed, one existing Starlette deprecation warning, 33.85s. The unchanged Kitchen deadline diagnostic also passes all six cases; no application/test timeout was increased.
