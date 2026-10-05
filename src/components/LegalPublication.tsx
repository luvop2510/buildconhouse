import { Linking, Pressable } from 'react-native';

import { P, Section } from '@/src/components/LegalDocContent';
import { isLegalPublicationReady, legalNotice, legalPublicationTodo } from '@/src/config/legal';

export function LegalPublication() {
  if (!isLegalPublicationReady) {
    return <Section title="Publication requirement"><P>{legalPublicationTodo}</P></Section>;
  }
  return (
    <Section title="Operator and effective date">
      <P>{legalNotice.entity} · {legalNotice.address}</P>
      <P>Effective date: {legalNotice.effectiveDate}. Governing jurisdiction: {legalNotice.jurisdiction}.</P>
      <P>Retention: {legalNotice.retention}</P>
      <Pressable accessibilityRole="link" accessibilityLabel="Contact privacy support or request data deletion" onPress={() => void Linking.openURL(`mailto:${legalNotice.privacyEmail}`)} style={{ minHeight: 44, justifyContent: 'center' }}>
        <P>Privacy and deletion requests: {legalNotice.privacyEmail}</P>
      </Pressable>
      <Pressable accessibilityRole="link" accessibilityLabel="Contact support" onPress={() => void Linking.openURL(`mailto:${legalNotice.supportEmail}`)} style={{ minHeight: 44, justifyContent: 'center' }}>
        <P>Support: {legalNotice.supportEmail}</P>
      </Pressable>
      {legalNotice.grievance ? <P>Grievance contact: {legalNotice.grievance}</P> : null}
    </Section>
  );
}
