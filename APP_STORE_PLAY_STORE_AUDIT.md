# BuildCon House — App Store & Google Play Production Readiness Audit

Audit scope: `frontend/` (Expo Router / React Native managed app) reviewed 2026-07-16, evaluated
against Apple App Store Review Guidelines and Google Play Store policy requirements. This is
code/config evidence only — App Store Connect / Play Console listing state, signing certificates,
and reviewer-facing metadata were not available and are marked **Cannot Verify**. This
complements (does not replace) `PRODUCTION_READINESS_AUDIT.md` (general backend/infra) and
`MOBILE_UX_AUDIT.md` (responsive/touch-target polish) — findings from both are cross-referenced
where they double as store-compliance risks.

## Status legend

- **Blocker** — will cause App Store/Play rejection, or the app cannot be submitted at all.
- **High** — not an automatic rejection, but a real functional gap or policy answer you'll be forced to give honestly in console and that will look bad, or a near-certain review flag.
- **Medium** — should be fixed before or shortly after launch; unlikely to block review on its own.
- **Low** — polish/consistency item.
- **Cannot Verify** — requires a real signed build, device, or console access this repo doesn't provide.

## Executive summary

The app is a managed Expo Router project (`expo` 54, RN 0.81.5) with real `ios`/`android`
identifiers (`com.buildconhouse.app`) and an `eas.json`, which is real progress since the last
general audit (previously the bundle ID was still the Emergent scaffold default). But several
store-specific requirements are either unimplemented or unverifiable from source: there is no
privacy policy anywhere in the repo, no Sign in with Apple despite offering Google Sign-In to
every user (Apple Guideline 4.8), no push notifications, no offline handling, analytics/crash
reporting are wired but inert until secrets are supplied at build time, and the marketing icon
source is undersized for the App Store's 1024×1024 requirement. None of the store-listing
metadata (screenshots, descriptions, data-safety answers, age rating) exists in this repo, which
is expected — but there is also no `fastlane`/metadata folder or checklist tracking that those
have been prepared.

**Verdict: not ready to submit.** The Sign in with Apple gap and the missing privacy policy are
the two items most likely to produce an outright App Store rejection on first submission.

## Scores

| Area | Score | Assessment |
|---|---:|---|
| iOS (App Store) submission readiness | 25/100 | Bundle ID/build config exist; Sign in with Apple, privacy policy, and icon asset are missing/blocking |
| Android (Google Play) submission readiness | 35/100 | Package ID/adaptive icon exist; privacy policy, Data Safety prep, and target-API verification are missing/unverifiable |
| Deep links | 20/100 | Custom scheme only (`buildconhouse://`), no Universal Links / verified App Links, no in-app route handling for incoming links |
| Push notifications | 0/100 | Not implemented — no package, no permission flow, no device-token backend |
| Permissions | 70/100 | Minimal and honest (photo library only), but the iOS usage-description key was already flagged once and should be re-verified in a real build |
| Offline handling | 10/100 | No reachability detection, no cached data, no offline UX — network errors surface as raw fetch failures |
| Icons & splash | 45/100 | Config is structurally correct; source icon is undersized (512² vs. Apple's 1024² requirement), splash image aspect is unusual for the current plugin, favicon is non-square |
| Privacy policy / data disclosure | 0/100 | No privacy policy, terms, or data-handling disclosure exists anywhere in the app or backend |
| Analytics | 30/100 | Sentry/PostHog integrated but fully no-op without env secrets; zero `captureEvent` call sites in any screen |
| Crash reporting | 30/100 | Same as above — `initSentry()` is wired at app boot but DSN is unset, so nothing is currently captured |
| Accessibility | 25/100 | Only 10 of 84 screen files use any accessibility prop; `MOBILE_UX_AUDIT.md` independently documents sub-44px touch targets and hover-only actions across the app |
| Performance | Cannot Verify | No real-device profiling in this repo; `MOBILE_UX_AUDIT.md` flags `initialNumToRender={120}` on the catalog grid as not phone-safe |
| Store compliance (metadata/process) | 10/100 | No store-listing assets, EAS project link, or submission credentials found in the repository |

---

## Findings

### Blockers

| # | Area | Finding | Evidence | Why it blocks | Fix |
|---|---|---|---|---|---|
| 1 | iOS auth (Guideline 4.8) | The app offers Google Sign-In to **every** user — staff and customers, on the same shared login screen — with no Sign in with Apple option. | `frontend/src/state/auth.tsx:170-196` (`loginWithGoogle`, native flow uses `Linking.createURL("auth")` + `WebBrowser.openAuthSessionAsync` against `https://auth.emergentagent.com/`); `frontend/app/(auth)/login.tsx` calls it for both login modes. | Apple requires Sign in with Apple whenever a third-party/social login is offered, unless the app is exclusively for an organization's own employees. This app also serves external customers via the portal, so the employees-only exemption does not clearly apply. | Add Sign in with Apple as an equivalent option wherever Google Sign-In appears, or remove Google Sign-In from the customer-facing login path and keep it staff-only if that path truly is employee-only. Decide and document which, before submitting. |
| 2 | Legal/privacy | No privacy policy or terms of service exists anywhere in the repository — not in the app, not as a backend route, not referenced in any doc. | `grep` across `frontend/` and `backend/` for "privacy"/"terms" returns zero hits. | Both App Store Connect and Google Play Console require a live privacy policy URL before a build can be submitted, and it's a hard field in both consoles. The app collects customer PII (name, email, phone) and, once activated, PostHog analytics — this isn't optional. | Write and publish a privacy policy (hosted, stable URL) covering what's collected (auth data, customer PII, analytics once PostHog is enabled), who it's shared with (MongoDB Atlas, Supabase, PostHog, Sentry, Emergent's auth relay), and a contact/deletion-request path. Link it in both console listings and ideally from within the app (Settings). |
| 3 | iOS icon asset | Source icon is 512×512px. | `frontend/assets/images/icon.png` → `sips` reports `512×512`; referenced at `frontend/app.json:7`. | Apple's App Store icon requirement is 1024×1024 with no alpha channel. Expo/EAS will upscale the source at build time — best case a soft/blurry icon, worst case a build-time warning or App Store Connect asset-validation failure depending on the exact pipeline used. | Regenerate `icon.png` (and ideally `adaptive-icon.png`) at 1024×1024, flatten any transparency (Apple rejects icons with alpha), re-run `expo-doctor`. |
| 4 | Networking / ATS | No `NSAppTransportSecurity` exception is declared in `ios.infoPlist` (`frontend/app.json:14-17`), and the local `.env` currently points `EXPO_PUBLIC_BACKEND_URL` at a plain `http://` address. | `frontend/app.json`; `frontend/.env` (`EXPO_PUBLIC_BACKEND_URL=http://...`). | If a non-HTTPS backend URL is ever baked into a release build, iOS App Transport Security silently blocks every network request (and Android blocks cleartext by default on API 28+) — the app would boot to a fully broken, network-dead state, which is an instant App Store guideline 2.1 (completeness) rejection if a reviewer hits it. | Confirm the production EAS build profile injects an `https://` backend URL (this is almost certainly already true for real deploys, based on `PRODUCTION.md` — but there is no `eas.json` env-var/profile evidence in this repo confirming it, so treat it as unverified until checked). Never add an ATS exception as a workaround — fix the URL instead. |
| 5 | Build/submission pipeline | `frontend/app.json` has no `expo.extra.eas.projectId` / `expo.owner`, and `eas.json`'s `submit.production` block is empty (`{}`). `PRODUCTION.md` separately states: *"Use the Emergent publish button ... do not set up a separate EAS account or CLI."* | `frontend/app.json`; `frontend/eas.json:17-19`; `PRODUCTION.md:91-92`. | Two different, seemingly contradictory build paths exist in this repo: a real `eas.json` with build profiles, and operational guidance to bypass EAS entirely in favor of a third-party "Emergent publish" button. Neither path has verifiable evidence in this repo of having produced a signed, submitted build (no App Store Connect app record, no Play Console listing, no signing credentials/keystore reference). | Pick one path and document it as canonical. If Emergent's publish pipeline is authoritative, confirm it actually calls `eas build`/`eas submit` (or an equivalent) under the hood with this same `app.json`/`eas.json`, and that someone other than the platform has access to the resulting App Store Connect / Play Console app records — a store presence entirely owned by a third-party automation button is a business continuity risk, not just a compliance one. |

### High priority

| # | Area | Finding | Evidence | Risk | Fix |
|---|---|---|---|---|---|
| 6 | Push notifications | Not implemented at all — no `expo-notifications` (or any push package) in `package.json`, no permission-request flow, no device-token registration endpoint on the backend. | `frontend/package.json` dependency list; repo-wide search for `PushNotification`/`expo-notifications` returns nothing. | Not a rejection by itself (push is optional), but if the product narrative (order updates, follow-up reminders, payment confirmations) implies notifications anywhere in store-listing copy or screenshots, that copy would be misleading — Apple/Google both reject listings that promise functionality the binary doesn't have. | If notifications aren't launching in v1, make sure no store-listing text/screenshot implies otherwise. If they are expected, this is unbuilt work: `expo-notifications`, permission UX, device-token storage, and a delivery path from backend events (there's already an outbox/event system per `PRODUCTION_READINESS_AUDIT.md` that could feed it). |
| 7 | Deep links | `expo.scheme` is `buildconhouse` (a bare custom scheme) with no `associatedDomains` (iOS Universal Links) and no Android `intentFilters`/`autoVerify`. The only incoming-link handling in the app is the Google Sign-In return path (`Linking.getInitialURL()` / `Linking.createURL("auth")` in `frontend/src/state/auth.tsx:117-131,181`). Every other `Linking.*` call in the app is **outbound only** (`tel:`, `mailto:`, `wa.me`, PDF blob URLs — e.g. `dashboard.tsx:180-187`, `payments.tsx:180-187`, `followups.tsx:353-361`). | Repo-wide `Linking.` grep; `frontend/app.json:8`. | A bare custom-scheme link can be hijacked by any other app registering the same scheme, and it can't be used for "tap an emailed link, land on quotation #123" flows — there's no route parsing for that today even if the link opened the app. Google's Play Console increasingly nudges toward verified App Links for any scheme-handling app. | If deep-linking beyond the OAuth return is not a v1 requirement, no action needed beyond documenting that. If it is, add `ios.associatedDomains` + `android.intentFilters` with `autoVerify: true` against a real domain, and add route-level deep-link handling in `expo-router` (there is currently none). |
| 8 | Account deletion (Apple 5.1.1(v)) / Play Data Safety | No self-service account creation exists in the app (confirmed — no `/signup` or `/register` route; accounts are staff/admin-provisioned invites), so Apple's strict "in-app account deletion" trigger may not strictly apply. But there is also no user-facing deletion/deactivation *request* path of any kind, and Play's Data Safety form asks directly whether users can request data deletion. | Repo-wide search for signup/register routes: none found. No "delete account" UI found. | Play Console will require an explicit answer here regardless of whether Apple's stricter rule applies, and reviewers on both stores increasingly expect *some* stated path (even "contact support to delete your data") for apps holding customer PII. | Add a documented deletion-request path — at minimum a support email/flow referenced from Settings and the privacy policy — and answer the Play Data Safety questionnaire honestly with it. |
| 9 | Offline handling | No network-reachability library is used anywhere (`@react-native-community/netinfo` is not a dependency), no cached/last-known data strategy, no offline UX state. | `frontend/package.json` dependency list confirms no NetInfo equivalent. | Apple guideline 2.1 expects apps to behave reasonably, not hang or dead-end, when connectivity drops — reviewers do test in flight-mode/poor-network conditions. Right now, a lost connection surfaces as whatever raw fetch-error string each screen's local `catch` block happens to render (inconsistent per screen, per `usePermissionMatrix`'s own error handling in `src/hooks/use-permissions.ts:51-53` as one example of the pattern used app-wide). | Add a shared reachability signal and a consistent "you're offline" state at the shell level, at minimum for the primary data screens (catalog, quotations, payments). |
| 10 | Analytics & crash reporting are inert | `initSentry()` is called unconditionally at app boot (`app/_layout.tsx:17`) but is a no-op unless `EXPO_PUBLIC_SENTRY_DSN` is set; `captureEvent()` (PostHog) exists in `src/lib/monitoring.ts` but is not called from a single screen in the app — zero call sites outside its own definition file. | `frontend/src/lib/monitoring.ts`; repo-wide grep for `posthog`/`captureEvent` usage outside that file returns none. | Whatever the App Privacy "nutrition label" (iOS) or Data Safety form (Android) ends up saying about analytics, it currently reflects nothing — since no build-time secrets exist, a shipped v1 build would collect **no** crash data and **no** product analytics even though the SDKs are bundled. That's a wasted opportunity for launch-week bug visibility, not a compliance risk on its own — but if secrets are added later, the console privacy answers need to be updated to match, and if PostHog device/usage data is collected, it likely needs disclosure as "data linked to you" in Apple's nutrition label. | Decide before launch whether Sentry/PostHog credentials will be set for the v1 build. If yes: set them, wire at least a few `captureEvent` calls at key flows, and answer the privacy questionnaires accordingly. If no: don't claim crash reporting/analytics anywhere in review notes. |
| 11 | Accessibility | Only 10 of 84 `.tsx` screen/component files use any accessibility prop (`accessibilityLabel`/`accessibilityRole`/`accessibilityHint`/`accessible`). `MOBILE_UX_AUDIT.md` independently documents concrete violations: icon buttons at 30-40px (below the 44×44 minimum, `MOBILE_UX_AUDIT.md` P0 item 3), one-line-truncated business data that would break under Dynamic Type (`numberOfLines={1}` used broadly), and hover-only actions with no touch equivalent (`dashboard.tsx:86`). | `frontend/MOBILE_UX_AUDIT.md` (full file); repo-wide accessibility-prop grep. | Not an automatic rejection on either store, but both do informally weigh basic usability during review, and Google Play's pre-launch report specifically flags small touch targets and missing content descriptions. Given the volume of documented violations, a real VoiceOver/TalkBack pass would surface failures quickly. | This tracks with `MOBILE_UX_AUDIT.md`'s own P0/P1 list — treat that document's fixes as accessibility fixes too, not just visual polish, and add a VoiceOver/TalkBack pass to the pre-submission checklist. |

### Medium priority

| # | Area | Finding | Evidence | Fix |
|---|---|---|---|---|
| 12 | iOS privacy manifest | No `PrivacyInfo.xcprivacy` is present or configured in this repo. Apple has required a privacy manifest declaring "required reason API" usage (e.g., `UserDefaults`, used transitively by `@react-native-async-storage/async-storage`) for new/updated apps since mid-2024. | `frontend/package.json` (AsyncStorage present); no manifest file found. | Confirm what the current Expo SDK/EAS build actually merges automatically from autolinked native modules (many now ship their own manifests) — this can only be verified against a real build output, not source. Treat as **Cannot Verify** until a build is produced and inspected. |
| 13 | Splash screen asset shape | `splash-image.png` is 336×729 (a tall, poster-shaped image) configured at `imageWidth: 200` under the current `expo-splash-screen` plugin (`frontend/app.json:37-44`), which expects a small logo mark, not a full illustration. | `sips` output for `assets/images/splash-image.png`; `frontend/app.json:38-44`. | Verify on a real short-height device (e.g., iPhone SE) that the scaled image doesn't clip or dominate the screen oddly. Consider a square/near-square logo mark instead if the current one was designed for the old full-bleed splash model. |
| 14 | Orientation vs. tablet screenshots | `orientation: "portrait"` is fixed app-wide (`frontend/app.json:6`) while `.screenshots/` contains iPad **landscape** captures, and `ios.supportsTablet: true` is set. | `frontend/app.json:6,12`; `.screenshots/iPad_Landscape_*`. | If those landscape captures were web-only (not a native build constraint), no issue. If landscape iPad support is actually intended, `orientation` needs to allow it; if not, drop the landscape screenshots from any store-asset pipeline and confirm iPad screenshots are prepared in portrait only (still required for a "Universal" app unless iPhone-only is declared in App Store Connect). |
| 15 | No OTA update channel | `expo-updates` is not configured. | `frontend/package.json` dependency list. | Not required, but without it, every JS-only bug fix after launch needs a full store resubmission and review cycle on both platforms. Worth a deliberate yes/no decision, not an oversight. |
| 16 | Favicon non-square | `favicon.png` is 512×513px (1px off-square). | `sips` output. | Cosmetic, web-only (PWA/browser tab icon) — not an app-store submission concern, but cheap to fix while regenerating the 1024×1024 app icon anyway. |
| 17 | Android permission set | Only `READ_MEDIA_IMAGES` is declared (`frontend/app.json:26-28`), and it's consistent with actual usage — the app only calls `launchImageLibraryAsync`/`requestMediaLibraryPermissionsAsync` (`ProductImageManager.tsx:65-67`, `settings-company.tsx:36-38`), never camera or microphone capture. This is good practice (Play flags apps that over-request), just needs re-verification against the generated manifest in a real build. | `frontend/app.json`; grep for ImagePicker call sites. | Low-effort: after the first real EAS/Emergent build, diff the generated `AndroidManifest.xml` permissions against this list to confirm nothing extra was pulled in by a transitive dependency. |

---

## What "Cannot Verify" actually means here

The following can only be confirmed against a real signed build and/or console access, not this repository:

- Whether the "Emergent publish" pipeline (per `PRODUCTION.md §5`) produces a build whose generated `Info.plist`/`AndroidManifest.xml` matches what `app.json` declares (usage-description strings, permissions, ATS settings).
- Target SDK/API level actually compiled into the Android build (Play requires targeting a recent API level — 34/35 as of 2025 policy — for new submissions and updates).
- App Store Connect / Play Console listing state: name availability, screenshots per required device size, description/keywords, support and marketing URLs, age rating questionnaire answers, App Privacy "nutrition label" answers, Play Data Safety form answers, ads declaration.
- Whether Play App Signing is enrolled and who holds the upload key.
- Whether a review-account (fresh, non-production credentials) has been prepared for App Store/Play reviewers — under no circumstances should the currently-live `owner@forge.app` / `[legacy password removed; use injected test credentials]` demo credential (flagged as a P0 in `PRODUCTION_READINESS_AUDIT.md`) be handed to a reviewer or left active at all by launch.
- Real-device performance (cold start time, catalog-grid scroll performance at `initialNumToRender={120}` per `MOBILE_UX_AUDIT.md`, memory behavior on low-end Android) — nothing here was profiled on-device.

---

## Pre-submission checklist

- [ ] Decide Sign in with Apple: add it, or restrict Google Sign-In to a provably employees-only surface, and document the decision.
- [ ] Publish a privacy policy (hosted URL) covering all data collected/shared (auth, customer PII, analytics if enabled) and link it in both console listings and in-app Settings.
- [ ] Regenerate `icon.png`/`adaptive-icon.png` at 1024×1024, no alpha channel.
- [ ] Confirm the production build's `EXPO_PUBLIC_BACKEND_URL` is `https://` — never paper over with an ATS/cleartext exception.
- [ ] Pick one canonical build/submit path (EAS directly, or Emergent's pipeline) and confirm who has access to the resulting App Store Connect / Play Console app records.
- [ ] Rotate the live demo credential (`owner@forge.app` / `[legacy password removed; use injected test credentials]`) before any reviewer or public build exists; prepare a fresh, scoped reviewer account instead.
- [ ] Decide and document a v1 stance on: push notifications, deep-linking beyond OAuth return, offline UX, and whether Sentry/PostHog will actually be enabled — then make store-listing copy and privacy answers match whatever was decided.
- [ ] Add at minimum a "request account/data deletion" path (support email is enough) and answer Play's Data Safety questionnaire accordingly.
- [ ] Run a VoiceOver pass (iOS) and TalkBack pass (Android) against the touch-target and truncation issues already catalogued in `MOBILE_UX_AUDIT.md`.
- [ ] After the first real release build: diff generated `Info.plist`/`AndroidManifest.xml` against `app.json`'s declared permissions/usage strings; inspect the merged `PrivacyInfo.xcprivacy`; confirm target API level.
- [ ] Prepare store-listing assets (screenshots per required size/orientation, description, keywords, age rating, ads declaration) — none exist in this repository today.
