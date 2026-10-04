# Google Play release checklist

Complete and record each item for the exact AAB being submitted. Do not submit while the legal-publication requirement in `src/config/legal.ts` is unresolved.

- [ ] Publish stable, unauthenticated HTTPS URLs for `/privacy` and `/terms`; replace the legal-publication release gate with verified operator facts.
- [ ] Complete Play Console Data safety declarations from actual collection, sharing, retention, and deletion behavior; update them if Sentry or any analytics processor is enabled.
- [ ] Verify the privacy-policy URL in the store listing opens without a login, redirects, or geo restriction.
- [ ] Build the release AAB with an EAS environment that supplies `EXPO_PUBLIC_BACKEND_URL` as HTTPS. Do not put a production URL in `eas.json`.
- [ ] Inspect the generated `AndroidManifest.xml`: package name, target SDK, exported components, and the final permissions must match the release declaration.
- [ ] Verify Android App Bundle signing uses the intended Play App Signing/upload-key configuration and retain the upload key securely.
- [ ] Provide a reviewer app-access account and clear instructions if any part of the app requires sign-in.
- [ ] Review each requested permission against a user-visible feature; remove unused permissions and complete every related Play policy declaration.
- [ ] Upload accurate phone and tablet screenshots, feature graphic, title, description, category, contact email, and content-rating answers.
- [ ] Complete ads, content, financial-features, and other policy declarations truthfully; retain evidence of each answer.
- [ ] Install the signed AAB on a physical Android device and verify sign-in, privacy/terms routes, image upload, downloads, and logout.
