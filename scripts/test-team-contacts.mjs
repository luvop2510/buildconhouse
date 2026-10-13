import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
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

// Run the actual edit-sheet hooks with separate layout and passive phases. This
// models the frame in which a user can clear contacts, before passive network
// effects run; the saved values must already be present and must not return.
const teamSource = readFileSync(new URL('../app/(admin)/team.tsx', import.meta.url), 'utf8');
const observationPoint = '  if (!staff) return null;';
assert.ok(teamSource.includes(observationPoint));
const observedSource = teamSource.replace(observationPoint, '  return { phone, mobile, email, username, setPhone, setMobile, setEmail };') + '\nexport { EditStaffSheet as ObserveEditStaffSheet };';
const compiled = ts.transpileModule(observedSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const hooks = [], layoutEffects = [], passiveEffects = [];
let cursor = 0, dirty = false;
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index]));
const schedule = queue => (callback, deps) => {
  const slot = cursor++;
  if (!sameDeps(hooks[slot]?.deps, deps)) {
    const previous = hooks[slot];
    hooks[slot] = { deps };
    queue.push(() => { previous?.cleanup?.(); hooks[slot].cleanup = callback(); });
  }
};
const react = {
  useState(initial) {
    const slot = cursor++;
    hooks[slot] ||= { value: typeof initial === 'function' ? initial() : initial };
    return [hooks[slot].value, value => {
      const next = typeof value === 'function' ? value(hooks[slot].value) : value;
      if (!Object.is(next, hooks[slot].value)) { hooks[slot].value = next; dirty = true; }
    }];
  },
  useRef(initial) { return hooks[cursor++] ||= { current: initial }; },
  useLayoutEffect: schedule(layoutEffects),
  useEffect: schedule(passiveEffects),
};
const exports = {};
const never = new Promise(() => {});
vm.runInNewContext(compiled, { exports, require: name => {
  if (name === 'react') return react;
  if (name === 'react-native') return { StyleSheet: { create: value => value } };
  if (name === '@/src/theme/tokens') return { colors: {}, spacing: {}, radius: {}, type: {} };
  if (name === '@/src/team-contacts') return { optionalContact };
  if (name === '@/src/team-delegation') return {};
  if (name === '@/src/api/client') return { api: { get: () => never } };
  return {};
} });
let staff = { id: 'saved-worker', full_name: 'Saved worker', role: 'worker', active: true, login_id: 'SAVED', phone: '+91 (079) 2345-6789', mobile: '+91 98765 43210', email: 'saved@example.test' };
let observed;
const editOptions = { catalog: { resources: [] } };
function commit() {
  do {
    dirty = false; cursor = 0;
    observed = exports.ObserveEditStaffSheet({ staff, options: editOptions });
    while (layoutEffects.length) layoutEffects.shift()();
  } while (dirty);
  return observed;
}
commit();
assert.equal(observed.phone, staff.phone, 'Saved phone is initialized before interaction');
assert.equal(observed.mobile, staff.mobile);
assert.equal(observed.email, staff.email);
observed.setPhone(''); observed.setMobile(''); observed.setEmail('');
commit();
while (passiveEffects.length) passiveEffects.shift()();
commit();
assert.equal(observed.phone, '', 'Passive effects cannot restore a contact cleared immediately after opening');
assert.equal(observed.mobile, '');
assert.equal(observed.email, '');
staff = { ...staff, id: 'another-worker', phone: '9876543210', mobile: null, email: null };
commit();
assert.equal(observed.phone, staff.phone, 'A changed staff document is initialized before the next interactive frame');
assert.equal(observed.mobile, '');
assert.equal(observed.email, '');
console.log('Team edit initialization: saved contacts are ready before interaction and immediate clears survive passive effects');
