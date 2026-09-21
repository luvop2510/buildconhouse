// BuildCon House · Privacy & Data
// APP_STORE_PLAY_STORE_AUDIT.md Blocker #2: no privacy disclosure existed
// anywhere in the app. This screen is the in-app half of the requirement;
// app/privacy.tsx is the public, unauthenticated hosted-URL half App Store
// Connect / Google Play Console require in their submission forms. Both
// render PrivacyPolicyContent so the copy can't drift between them.
import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { PrivacyPolicyContent } from "@/src/components/PrivacyPolicyContent";

export default function SettingsPrivacy() {
  return (
    <AdminPage title="Privacy & Data" subtitle="What we collect, why, and how to request deletion">
      <PrivacyPolicyContent />
    </AdminPage>
  );
}
