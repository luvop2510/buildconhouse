import assert from 'node:assert/strict';
import { defaultQuotationMessage, quotationPdfPath } from '../src/utils/quotationWhatsApp.ts';

assert.equal(defaultQuotationMessage('  Mira Shah  '), 'Hey Mira Shah, here is your quotation.');
assert.equal(defaultQuotationMessage(''), 'Hey Customer, here is your quotation.');
assert.equal(quotationPdfPath('quotation 1'), '/quotations/quotation%201/pdf?include_dimensions=false');
assert.equal(quotationPdfPath('quotation/2', true), '/quotations/quotation%2F2/pdf?include_dimensions=true');
console.log('Quotation PDF attachment contracts passed.');
