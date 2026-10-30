import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { formatPhone, validPhone } from '../src/utils/phone.ts';
import { referrerCode, referrerLabel } from '../src/utils/referrer.ts';

for (const value of ['9909955755', '990-995-57-55', '(990) 995 5755']) assert.equal(formatPhone(value), '990-995-57-55');
assert.equal(formatPhone('+91 9909955755'), '+91 990-995-57-55');
assert.equal(formatPhone(null), '');
assert.equal(formatPhone('123'), '123');
assert.equal(formatPhone('+44 20 7946 0958'), '+44 20 7946 0958', 'foreign contacts must not lose their country or digits');
assert.equal(formatPhone('9909955755 ext 2'), '9909955755 ext 2');
assert.equal(validPhone('990-995-57-55'), true);
assert.equal(validPhone('+91 9909955755'), true);
for (const value of ['', '123', '9909955755abc', '1234567890123']) assert.equal(validPhone(value), false);
assert.equal(referrerCode('4d2a6042-78a7-453b-a7be-97d60ed4571d', 'architect', 'Nikita Shah'), 'ARC-NIKITA-4D2A6042');
assert.equal(referrerLabel({ referrer_id: '4d2a6042-78a7-453b-a7be-97d60ed4571d', referrer_name: 'Nikita Shah', referrer_type: 'architect' }), 'Nikita Shah · ARC-NIKITA-4D2A6042');

// Exercise the real shared input through focus, editing, paste and blur.
const source = readFileSync(new URL('../src/components/AppText.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
let state = [], slot = 0;
const modules = {
  react: { forwardRef: fn => fn, useEffect: () => {}, useRef: value => ({ current: value }), useState: value => { const index = slot++; state[index] ??= value; return [state[index], next => state[index] = next]; } },
  'react-native': { Platform: { OS: 'web' }, StyleSheet: { flatten: value => value }, Text: 'Text', TextInput: 'TextInput' },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }) },
  './appTextFamily': { appTextFamily: () => 'system-ui' },
  '@/src/hooks/use-input-active': { reportInputFocus: () => {} },
  '@/src/utils/phone': { formatPhone },
};
const exports = {};
vm.runInNewContext(compiled, { exports, require: name => { assert.ok(modules[name], name); return modules[name]; }, Symbol });
let draft = '9909955755';
const render = (extra = {}) => { slot = 0; return exports.TextInput({ value: draft, keyboardType: 'phone-pad', maxLength: 10, onChangeText: value => { draft = value; }, ...extra }).props; };
assert.equal(render().value, '990-995-57-55');
render().onFocus({});
assert.equal(render().value, '9909955755', 'editing uses the original ten-character draft with its existing maxLength');
render().onChangeText('990995575');
assert.equal(render().value, '990995575', 'backspace is preserved without restoring separators');
render().onChangeText('990-9955755');
assert.equal(render().value, '990-9955755', 'separator deletion must not be undone while focused');
render().onChangeText('+91 9909955755');
assert.equal(draft, '+91 9909955755', 'paste preserves the input payload and country prefix');
render().onBlur({});
assert.equal(render().value, '+91 990-995-57-55');
assert.equal(render({ keyboardType: 'default', value: '9909955755' }).value, '9909955755', 'non-contact numeric fields stay untouched');
console.log('Phone display/input and named reference codes passed.');
