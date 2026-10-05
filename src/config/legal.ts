// This is deliberately the only legal-publication release gate. The repository
// does not contain verified registration or jurisdiction facts, so they must
// be supplied by the operator rather than guessed in a customer-facing policy.
export const legalPublicationTodo =
  'Before publishing or submitting this app, the operator must supply its legal entity name, registered address, privacy/support contact, retention schedule, effective date, grievance contact (if applicable), and governing-law jurisdiction.';

// Public, operator-verified facts only. Never put deployment secrets in these
// EXPO_PUBLIC variables. Both hosted and in-app policies use this same source.
export const legalNotice = {
  entity: (process.env.EXPO_PUBLIC_LEGAL_ENTITY || '').trim(),
  address: (process.env.EXPO_PUBLIC_LEGAL_ADDRESS || '').trim(),
  privacyEmail: (process.env.EXPO_PUBLIC_PRIVACY_EMAIL || '').trim(),
  supportEmail: (process.env.EXPO_PUBLIC_SUPPORT_EMAIL || '').trim(),
  retention: (process.env.EXPO_PUBLIC_DATA_RETENTION || '').trim(),
  effectiveDate: (process.env.EXPO_PUBLIC_LEGAL_EFFECTIVE_DATE || '').trim(),
  jurisdiction: (process.env.EXPO_PUBLIC_LEGAL_JURISDICTION || '').trim(),
  grievance: (process.env.EXPO_PUBLIC_GRIEVANCE_CONTACT || '').trim(),
};

export const isLegalPublicationReady =
  Object.entries(legalNotice).filter(([key]) => key !== 'grievance').every(([, value]) => Boolean(value)) &&
  /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(legalNotice.privacyEmail) &&
  /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(legalNotice.supportEmail) &&
  /^\d{4}-\d{2}-\d{2}$/.test(legalNotice.effectiveDate) &&
  Number.isFinite(Date.parse(legalNotice.effectiveDate)) &&
  new Date(legalNotice.effectiveDate).toISOString().slice(0, 10) === legalNotice.effectiveDate;
