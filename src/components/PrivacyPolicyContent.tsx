// Privacy & Data policy copy — single source of truth.
// Rendered both in-app (app/(admin)/settings-privacy.tsx, behind staff auth)
// and on the public, unauthenticated /privacy route (app/privacy.tsx) that
// App Store Connect / Google Play Console require a hosted URL for. Keep
// both call sites importing this component rather than duplicating copy —
// the two are required to say the same thing.
//
import { View } from "react-native";

import { brand, space } from "@/src/design/tokens";
import { P, Section } from "@/src/components/LegalDocContent";
import { LegalPublication } from "@/src/components/LegalPublication";
import { isLegalPublicationReady, legalNotice } from "@/src/config/legal";

export function PrivacyPolicyContent() {
  return (
    <View style={{ gap: space.x6 }}>
      <Section title="What this covers">
        <P>
          {brand.name} is a workspace for staff to manage quotations, orders, and payments, and a
          portal customers use to view their own orders. This page describes what data the app
          collects, where it is stored, and how to exercise your rights over it.
        </P>
        <P>This notice applies to the currently published version of the app.</P>
      </Section>

      <LegalPublication />

      <Section title="Data we collect">
        <P>Staff accounts: name, email, phone (optional), a hashed password, and role/floor
          assignment.</P>
        <P>Customer records (entered by staff, not by the customer): name, company, email, phone,
          address, city, and tax ID (GSTIN) where applicable. If customer portal access is enabled,
          the customer also gets a hashed password.</P>
        <P>Business records: quotations, purchase orders, payments, and an audit trail of changes
          made to them (who changed what, and when) — this is core to how the app functions and is
          retained as a business record, not discretionary tracking.</P>
      </Section>

      <Section title="Third-party processors">
        <P>Database records are hosted on MongoDB Atlas. Product photos, company logos, and
          document attachments are stored on Supabase. Both are third-party infrastructure
          providers processing data on our behalf, not independent data users.</P>
        <P>If enabled by your administrator, crash reports and sampled technical performance
          metrics are sent to Sentry. They exclude account details, customer records, request
          bodies, query strings, and navigation history; monitoring is off by default and
          activates only when the deployment has been configured with its credentials.</P>
      </Section>

      <Section title="Data retention">
        <P>
          Staff and customer account records are retained for as long as the account is active.
          Quotations, purchase orders, and payment records are retained only for the published
          retention schedule and any applicable tax, accounting, dispute-resolution, or legal
          obligation. {isLegalPublicationReady ? legalNotice.retention : 'That schedule must be made available before this notice is published.'}
        </P>
      </Section>

      <Section title="Your rights">
        <P>
          You can request a copy of the personal data this app holds about you, ask that
          inaccurate data be corrected, or request deletion of your account (see &quot;Requesting
          deletion&quot; below). Some records may be retained after a deletion request where retention
          is required for financial record-keeping or to resolve an open business transaction.
        </P>
      </Section>

      <Section title="Requesting deletion">
        <P>
          Staff and customer accounts in this app are created by an administrator, not
          self-registered — to request that your account or personal data be deleted, contact the
          owner or manager who set up your access, or use the published privacy contact. They can
          deactivate or remove the record; historical quotation/payment records tied to completed
          business transactions may be retained as required for financial record-keeping even
          after an account is deactivated.
        </P>
      </Section>

      <Section title="Changes to this policy">
        <P>
          If this policy changes, the updated version will be posted at this same location with a
          new effective date. Where a change requires your consent, we will request it before
          applying that change to your data.
        </P>
      </Section>
    </View>
  );
}
