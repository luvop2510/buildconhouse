import assert from 'node:assert/strict';
import { optionalContact, validateTeamContacts, teamErrorMessage } from '../src/team-contacts.ts';

assert.equal(optionalContact('  '), null);
assert.equal(optionalContact(null), null);
for (const value of [123, true, {}, [], NaN]) assert.equal(optionalContact(value), null);
assert.equal(optionalContact(' user@example.test '), 'user@example.test');
for (const number of ['9876543210', '+91 (079) 2345-6789', '020 1234 5678', '1234567', '123456789012345']) {
  assert.equal(validateTeamContacts('', 'JK', number, number), null, number);
}
for (const number of ['123456', '1234567890123456', '+91abc1234567', '１２３４５６７８９０', '1+234567', '1234567\n890', '1234567 ext 23']) {
  assert.match(validateTeamContacts('', 'JK', number, '') || '', /^Phone/);
  assert.match(validateTeamContacts('', 'JK', '', number) || '', /^Mobile/);
}
assert.equal(validateTeamContacts('', '', '', ''), 'Add an email or username so this person can sign in');
assert.equal(validateTeamContacts('person@example.test', '', '', ''), null);
for (const email of ['name', 'bad@', '@example.test', 'a b@example.test', 'x'.repeat(255) + '@example.test']) {
  assert.equal(validateTeamContacts(email, 'JK', '', ''), 'Enter a valid email address');
}
const validation = [{ loc: ['body', 'phone'], msg: 'Invalid phone number', type: 'value_error' }];
assert.equal(teamErrorMessage({ detail: validation }, 'fallback'), 'phone: Invalid phone number');
assert.equal(teamErrorMessage({ detail: JSON.stringify(validation) }, 'fallback'), 'phone: Invalid phone number');
assert.equal(teamErrorMessage({ detail: 'Conflict' }, 'fallback'), 'Conflict');
for (const detail of [null, {}, [], [{ msg: 42 }], 22]) assert.equal(teamErrorMessage({ detail }, 'fallback'), 'fallback');
console.log('Team contacts: optional fields, valid/invalid numbers, sign-in identity and structured validation errors passed');
