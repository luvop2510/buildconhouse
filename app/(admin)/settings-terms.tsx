// BuildCon House · Terms of Service
// In-app half of the Terms of Service requirement; app/terms.tsx is the
// public, unauthenticated hosted-URL half App Store Connect / Google Play
// Console require in their submission forms. Both render
// TermsOfServiceContent so the copy can't drift between them.
import { SettingsPage as AdminPage } from "@/src/components/settings/SettingsPage";
import { TermsOfServiceContent } from "@/src/components/TermsOfServiceContent";

export default function SettingsTerms() {
  return (
    <AdminPage title="Terms of Service" subtitle="The terms that govern using this app">
      <TermsOfServiceContent />
    </AdminPage>
  );
}
