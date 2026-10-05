// Terms of Service copy — single source of truth.
// Rendered both in-app (app/(admin)/settings-terms.tsx, behind staff auth)
// and on the public, unauthenticated /terms route (app/terms.tsx) that
// App Store Connect / Google Play Console require a hosted URL for,
// mirroring how app/privacy.tsx and PrivacyPolicyContent.tsx are split.
//
import { View } from "react-native";

import { brand, space } from "@/src/design/tokens";
import { P, Section } from "@/src/components/LegalDocContent";
import { LegalPublication } from "@/src/components/LegalPublication";

export function TermsOfServiceContent() {
  return (
    <View style={{ gap: space.x6 }}>
      <Section title="Agreement">
        <P>
          These Terms of Service govern access to and use of {brand.name}. By signing in, you
          agree to these terms as published in the app.
        </P>
      </Section>

      <LegalPublication />

      <Section title="Who this applies to">
        <P>
          Staff accounts are created and assigned by an administrator, scoped to a role and one or
          more floors/departments — you may not use a staff account outside the access your
          administrator has granted. Customer accounts are created by staff on your behalf and
          give you read-only access to your own quotations, orders, and payment status — you may
          not use a customer account to access another customer&apos;s records.
        </P>
      </Section>

      <Section title="Account responsibilities">
        <P>
          You&apos;re responsible for keeping your login credentials confidential and for all activity
          under your account. Tell your administrator immediately if you suspect unauthorized
          access. Temporary passwords issued by an administrator must be changed on first sign-in
          and expire if unused.
        </P>
      </Section>

      <Section title="Acceptable use">
        <P>
          Use {brand.name} only for its intended purpose: managing and viewing quotations,
          purchase orders, payments, and related business records. Don&apos;t attempt to access data
          outside your assigned role/floor scope, interfere with the app&apos;s operation, or use it to
          store or transmit unlawful content.
        </P>
      </Section>

      <Section title="Content and ownership">
        <P>
          Quotations, purchase orders, and other documents you create or view through the app
          remain the business records of {brand.name} and the customer they relate to. The app&apos;s
          software, design, and branding are owned or licensed by the app operator and may not be
          copied or redistributed outside normal use of the app.
        </P>
      </Section>

      <Section title="Disclaimers and liability">
        <P>
          The app is provided &quot;as is.&quot; While we take reasonable care to keep quotation, order, and
          payment data accurate, you should confirm pricing and order details through your normal
          business process before relying on them for a transaction. To the extent permitted by
          law, the app operator is not liable for indirect or consequential loss arising from
          use of the app.
        </P>
      </Section>

      <Section title="Termination">
        <P>
          An administrator may deactivate any staff or customer account at any time, including on
          request. We may suspend access to the app for maintenance, security, or if these terms
          are violated.
        </P>
      </Section>

      <Section title="Governing law">
        <P>
          These terms are governed by the jurisdiction identified in the published legal notice,
          without regard to conflict-of-law principles.
        </P>
      </Section>

      <Section title="Changes to these terms">
        <P>
          If these terms change, the updated version will be posted at this same location with a
          new effective date. Continued use of the app after a change takes effect means you
          accept the updated terms, where permitted by law.
        </P>
      </Section>

      <Section title="Contact">
        <P>Questions about these terms can be sent to the published support contact.</P>
      </Section>
    </View>
  );
}
