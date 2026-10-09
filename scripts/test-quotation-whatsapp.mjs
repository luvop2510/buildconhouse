import assert from 'node:assert/strict';
import { defaultQuotationMessage, quotationWhatsAppUrl } from '../src/utils/quotationWhatsApp.ts';

assert.equal(defaultQuotationMessage('  Mira Shah  '), 'Hey Mira Shah, here is your quotation.');
assert.equal(defaultQuotationMessage(''), 'Hey Customer, here is your quotation.');
const pdf = 'https://erp.example.test/api/quotations/shared-pdf/opaque_token';
const custom = 'Hey મીરા, here is your quotation. Please check Basin & Shower #2.';
const link = new URL(quotationWhatsAppUrl('919909906652', custom, pdf));
assert.equal(link.origin, 'https://wa.me');
assert.equal(link.pathname, '/919909906652');
assert.equal(link.searchParams.get('text'), `${custom}\n\n${pdf}`);
assert.throws(() => quotationWhatsAppUrl('99099 06652', custom, pdf), /international/);
assert.throws(() => quotationWhatsAppUrl('', custom, pdf), /international/);
assert.throws(() => quotationWhatsAppUrl('919909906652', ' ', pdf), /Enter a message/);
assert.throws(() => quotationWhatsAppUrl('919909906652', custom, 'javascript:alert(1)'), /invalid/);
console.log('Quotation WhatsApp draft contracts passed.');
