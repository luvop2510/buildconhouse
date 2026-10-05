# Store submission and physical-device acceptance

5 October 2026. Prepared from current source and official store guidance. This
document is a submission worksheet, not an attestation that forms were submitted.

## Listing copy ready for operator review

Name: **BuildCon House**. Category: Business (confirm in each store).

Short description: **Manage product quotations, purchases, stock and payments.**

Description:

> BuildCon House helps authorized teams manage their product catalog, create
> quotations, track purchases and stock, and record payments. Separate business
> floors keep departmental workflows organized. Staff can prepare product
> quotations and export documents; customers with administrator-provided access
> can view their own business records. An internet connection and an account
> provided by your administrator are required.

Public policy URLs:
`https://buildcon-house-nine.vercel.app/privacy` and
`https://buildcon-house-nine.vercel.app/terms`.
These routes exist without sign-in. They remain publication-blocked until the
verified facts below are supplied. Do not use the privacy page as a support URL
without a working, visible contact method.

Capture screenshots from the exact signed release on the required device sizes
using isolated sample customers/orders. Exclude real names, phone numbers,
addresses, payment references and password dialogs. Do not promise push
notifications, offline editing or a Kitchen/Furniture placed-order workflow that
the release does not provide. Complete content/age ratings from actual features.

## Public legal facts and privacy worksheet

Both hosted and in-app policies render the shared `LegalPublication` component.
It displays verified operator/contact/retention details when all required public
build variables are present; otherwise the existing publication requirement
remains visible. The code cannot invent registration or retention facts.

Required public build variables: `EXPO_PUBLIC_LEGAL_ENTITY`,
`EXPO_PUBLIC_LEGAL_ADDRESS`, `EXPO_PUBLIC_PRIVACY_EMAIL`,
`EXPO_PUBLIC_SUPPORT_EMAIL`, `EXPO_PUBLIC_DATA_RETENTION`,
`EXPO_PUBLIC_LEGAL_EFFECTIVE_DATE` (YYYY-MM-DD), and
`EXPO_PUBLIC_LEGAL_JURISDICTION`. Add `EXPO_PUBLIC_GRIEVANCE_CONTACT` if applicable.
These are public facts, never credentials. Confirm jurisdiction/retention with
the responsible operator before publishing. Rebuild web and native releases
with the same values and test the email links.

| Data / capability | Current source evidence | Declaration work |
| --- | --- | --- |
| Staff/customer identity and contact details | Accounts, customer names/email/phone/address/GSTIN; assigned role/floor | Declare collected personal information for account/business functionality; confirm linked-to-user categories |
| Orders, quotations and payment records | Business transactions, payment status and audit events | Declare actual transaction/financial/user content categories; app does not process card credentials merely because it records a payment |
| Uploaded photos/logos/attachments | Image picker and file/storage paths | Declare user-selected media/content transferred to Supabase; device contacts/location are not requested |
| Crash/performance diagnostics | Sentry packages; activated only with configured DSNs | Verify the exact submitted binary/deployment configuration. Declare diagnostics if enabled; do not answer No merely because monitoring is optional |
| Processors | MongoDB Atlas, Supabase, Vercel, Railway; Sentry if enabled | Verify provider contracts/regions/retention and store definitions of collection versus sharing |
| Advertising/tracking | No app advertising or advertising-ID integration found in source | Recheck the signed dependency/manifest inventory before answering tracking questions |
| Microphone/camera | App plays a selection sound; recording/camera APIs unused; permissions explicitly blocked | Expo introspection after the patch shows no iOS microphone/camera usage entry and Android remove directives for camera/audio/media/location permissions. Inspect the final merged signed manifest too |
| Deletion | Administrator-provisioned accounts; protected completed business records | Verify request handling and published privacy email. Explain lawful retained records and deletion timeline accurately; no blanket exemption claim |

[Apple review](https://developer.apple.com/app-store/review/) requires working
review access and clear retention/deletion policies.
[Apple account deletion guidance](https://developer.apple.com/support/offering-account-deletion-in-your-app/)
and [Google deletion requirements](https://support.google.com/googleplay/android-developer/answer/13327111)
must be checked against the actual account-creation flow.
[Google User Data policy](https://support.google.com/googleplay/android-developer/answer/10144311)
requires accurate Data safety disclosures. Store form definitions can differ
from a developer's internal definition of analytics or sharing.

Official Google policy pages were rechecked on 6 October 2026. Their current
account-deletion guidance permits a customer-service email or request form as
the external request pathway, but temporary deactivation is not deletion.
Verify actual request fulfillment, retained business-record justification and
provider deletion handling before declaring this capability. Administrator
provisioning alone is not evidence that a publicly listed app is exempt; the
listed exceptions must match the actual distribution and account flow.

## Reviewer access instructions

Provision a dedicated, minimally privileged review account against an isolated
review environment containing representative sample catalog/quotations/orders.
Give the reviewer both staff workflow access and a sample customer-portal login
if both experiences are submitted. Scope staff to sample floors; do not hand
out a production administrator account or expose live customers. Keep credentials
in App Store Connect/Play Console review fields, never this repo or screenshots.
Confirm any temporary password has been changed and review credentials will
remain valid for the review period. Test a fresh session without internal VPN.

Review journey: sign in → select Sanitary Bathroom → Catalog/product images →
create/update a quotation → export PDF/PPT → Purchases/stock → transfer sample
stock → zero-stock history → Payments → edit linked quotation → Ground Floor
isolated catalog/orders → customer portal own records → privacy/terms → logout.
State that payment records represent existing business transactions, not an
in-app purchase flow. Provide support contact, backend availability and any
required sample setup in the review notes. No review account credentials or
signed store build were available to complete this step in the workspace.

## Physical-device acceptance record

| Device | Required release evidence | Current status |
| --- | --- | --- |
| iPhone | Model/iOS, signed build/version, tester/date, result and screenshots | Pending physical device and signed build |
| iPad | Model/iPadOS, portrait/landscape/split-screen, signed build | Pending physical device and signed build |
| Android phone | Model/API, signed AAB/APK/version, gesture navigation | Pending physical device and signed build |
| Android tablet | Model/API, orientation/multitasking, signed build | Pending physical device and signed build |

For each device test cold startup/login/logout, account/floor isolation, the
Payments edit journey, correct finish images and full image frames, last-unit
transfer/zero-stock history, PDF/PPT save/share, keyboard avoidance, safe areas,
font scaling/accessibility, interrupted/slow/offline network and retry without
duplicate payment/transfer. Record scroll responsiveness, crash logs and warm
timing under a representative long catalog. A screenshot alone is not a pass.

This host has no available `xcrun devicectl`/`simctl` and no `adb`; repository
configuration lacks a linked EAS project. Browser touch/WebKit/tablet emulation
and unsigned Hermes export test different layers. They cannot certify physical
devices, signing, store review or native file-share behavior.
