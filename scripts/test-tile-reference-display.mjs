import assert from 'node:assert/strict';
import { documentReferenceText, documentReferrerName } from '../src/utils/referrer.ts';

assert.equal(documentReferrerName('Prashant Moliya', 'architect'), 'ARC-Prashant Moliya');
assert.equal(documentReferrerName('Nikita Shah', 'interior_designer'), 'INT-Nikita Shah');
assert.equal(documentReferenceText('Prashant Moliya · ARC-PRASHANT-D95B6E58'), 'ARC-Prashant Moliya');
assert.equal(documentReferenceText('Walk-in'), 'Walk-in');
