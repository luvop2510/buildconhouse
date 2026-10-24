import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the shipped button with a deterministic clock: success feedback is
// allowed to remain visible while a deliberate next quantity change proceeds.
const slots = [];
let cursor = 0, now = 0, nextTimer = 0, adds = 0;
const timers = new Map();
const react = {
  useState(initial) {
    const slot = cursor++;
    slots[slot] ??= { value: initial };
    return [slots[slot].value, value => { slots[slot].value = value; }];
  },
  useRef(initial) { return slots[cursor++] ??= { current: initial }; },
  useEffect(callback) { const slot = cursor++; if (!slots[slot]) slots[slot] = { cleanup: callback() }; },
};
const modules = {
  react,
  'react-native': { Pressable: 'Pressable', View: 'View', StyleSheet: { create: value => value } },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  '@expo/vector-icons/Feather': { default: 'Icon' },
  'expo-haptics': { selectionAsync() {} },
  '@/src/components/AppText': { Text: 'Text' },
  '@/src/components/Toast': { toast: { success() {} } },
  '@/src/theme/tokens': { colors: {}, radius: {} },
};
const exports = {};
vm.runInNewContext(ts.transpileModule(readFileSync(process.argv[2] || new URL('../src/components/quotation/shared/QuickAddButton.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText, {
  exports, require: name => { if (!(name in modules)) throw new Error(`Unexpected dependency ${name}`); return modules[name]; },
  setTimeout: (callback, delay) => { const id = ++nextTimer; timers.set(id, { callback, at: now + delay }); return id; },
  clearTimeout: id => timers.delete(id),
});
const render = () => { cursor = 0; return exports.QuickAddButton({ onAdd: () => adds++ }); };
const advance = delay => {
  now += delay;
  for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.callback(); }
};
let button = render();
button.props.onPress();
button.props.onPress();
assert.equal(adds, 1, 'An immediate duplicate tap is ignored');
advance(250);
button = render();
assert.equal(button.props.accessibilityLabel, 'Added', 'Success feedback is still visible');
button.props.onPress();
assert.equal(adds, 2, 'Feedback must not block a deliberate second addition');
for (const slot of slots) slot.cleanup?.();
assert.equal(timers.size, 0, 'Unmount cancels feedback and debounce timers');
console.log('Quotation quick-add duplicate protection and nonblocking feedback passed');
