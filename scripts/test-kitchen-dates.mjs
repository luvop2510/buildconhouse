import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/components/kitchen/KitchenDates.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const exports = {};
new Function('exports', compiled)(exports);
for (const [timestamp, expected] of [
  ['2026-10-22T18:29:59Z', '2026-10-22'],
  ['2026-10-22T18:30:00Z', '2026-10-23'],
  ['2026-12-31T20:00:00Z', '2027-01-01'],
  ['2028-02-28T20:00:00Z', '2028-02-29'],
]) assert.equal(exports.kitchenToday(new Date(timestamp)), expected, timestamp);
console.log('Kitchen date defaults: India midnight, year boundary and leap day passed');

// Exercise the actual date-field focus/click handlers on each supported platform.
const fieldSource = await readFile(new URL('../src/components/kitchen/KitchenFilters.tsx', import.meta.url), 'utf8');
const fields = {};
let platform = 'web';
let currentRefs;
let refCursor = 0;
let effects = [];
const element = (type, props, ...children) => ({ type, props: { ...props, children } });
const modules = {
  react: { createElement: element, useId: () => 'date-field', useRef: initial => currentRefs[refCursor++] || (currentRefs[refCursor - 1] = { current: initial }), useEffect: effect => effects.push(effect), useState: initial => [initial, () => {}] },
  'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
  'react-native': { Platform: { get OS() { return platform; } }, View: 'view', Pressable: 'button' },
  '@expo/vector-icons/Feather': 'icon', '@/src/components/AppText': { Text: 'text' },
  './KitchenPrimitives': { KitchenTextField: 'native-input', kitchenColors: {}, kitchenType: { label: {}, body: {} } },
  '@/src/design/navigationControls': { Menu: 'menu' }, '@/src/theme/tokens': { radius: {}, spacing: {} },
  './KitchenDates': { kitchenToday: () => exports.kitchenToday(new Date('2026-10-22T18:30:00Z')) },
};
new Function('require', 'exports', ts.transpileModule(fieldSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText)(name => {
  assert.ok(modules[name], name); return modules[name];
}, fields);
function inputs(tree) {
  if (!tree || typeof tree !== 'object') return [];
  if (Array.isArray(tree)) return tree.flatMap(inputs);
  let props = tree.props;
  if (tree.type === 'input') {
    const node = { value: props.value, onfocus: null, focused: 0, opened: 0,
      focus() { this.focused++; this.onfocus({ currentTarget: this }); },
      showPicker() { this.opened++; },
    };
    props.ref(node);
    props = { ...props, node, onFocus: () => node.onfocus({ currentTarget: node }) };
  }
  return [...(['input', 'native-input'].includes(tree.type) ? [props] : []), ...inputs(tree.props.children)];
}
function controlled(os, initial = '', options = {}) {
  platform = os;
  let value = initial;
  const changes = [];
  const references = [];
  let tree;
  const buttons = node => !node || typeof node !== "object" ? [] : Array.isArray(node) ? node.flatMap(buttons) : [...(node.props?.accessibilityRole === "button" ? [node.props] : []), ...buttons(node.props?.children)];
  return {
    changes, value: () => value, calendar: () => buttons(tree).find(button => button.accessibilityLabel === "Open date calendar"),
    render: () => { currentRefs = references; refCursor = 0; effects = []; tree = fields.KitchenDateField({ label: 'Date', value, onChange: next => { value = next; changes.push(next); }, ...options }); const result = inputs(tree); effects.forEach(effect => effect()); return result; },
  };
}
for (const os of ['web', 'ios', 'android']) {
  const view = controlled(os);
  let [input] = view.render();
  assert.equal(view.value(), '2026-10-23', `${os}: an editable blank selects India today on mount without any focus or click`);
  [input] = view.render();
  input.onFocus();
  assert.equal(view.value(), '2026-10-23', `${os}: opening a blank date chooses India today`);
  [input] = view.render();
  input.onClick?.();
  assert.deepEqual(view.changes, ['2026-10-23'], `${os}: repeated opening retains the selected date`);
  if (os === 'web') input.onChange({ target: { value: '2026-10-20' } });
  else input.onChangeText('2026-10-20');
  [input] = view.render(); input.onFocus();
  assert.equal(view.value(), '2026-10-20', `${os}: the user can edit and reopen a chosen date`);
  const history = controlled(os, '2025-02-03');
  history.render()[0].onFocus();
  assert.deepEqual(history.changes, [], `${os}: saved dates are never replaced with today`);
  const disabled = controlled(os, '', { disabled: true });
  const [disabledInput] = disabled.render();
  disabledInput.onFocus(); disabledInput.onClick?.();
  assert.deepEqual(disabled.changes, [], `${os}: disabled historical dates cannot be initialized`);
  assert.equal(os === 'web' ? disabledInput.disabled : !disabledInput.editable, true);
  const optedOut = controlled(os, '', { defaultToToday: false });
  optedOut.render()[0].onFocus();
  assert.deepEqual(optedOut.changes, [], `${os}: an explicit date-default opt-out remains supported`);
}
const clicked = controlled('web');
clicked.render()[0].onClick();
assert.equal(clicked.value(), '2026-10-23', 'Web picker clicks initialize a blank date even when it already had focus');
const timestamp = controlled('web', '2026-10-22T20:00:00Z', { kind: 'datetime' });
assert.equal(timestamp.render()[0].value, '2026-10-23T01:30', 'Existing timestamps render in India time');
timestamp.render()[0].onFocus();
assert.deepEqual(timestamp.changes, [], 'Opening an existing timestamp preserves its stored instant');
console.log('Kitchen date controls: automatic mount defaults and explicit-open recovery, preserved history/disabled values, editable choices and web/native handlers passed');

const calendarView = controlled('web');
let [calendarInput] = calendarView.render();
assert.equal(calendarInput.className, 'kitchen-date-input');
const htmlSource = await readFile(new URL('../app/+html.tsx', import.meta.url), 'utf8');
assert.match(htmlSource, /\.kitchen-date-input::\-webkit-calendar-picker-indicator\s*\{ display: none; \}/, 'Only Kitchen native indicators are hidden behind the visible accessible opener');
calendarView.calendar().onPress();
assert.equal(calendarInput.node.focused, 1);
assert.equal(calendarInput.node.opened, 1, 'Visible calendar button opens its own native picker');
calendarInput.node.showPicker = () => { throw new Error('showPicker unavailable in this browser'); };
assert.doesNotThrow(() => calendarView.calendar().onPress(), 'Unsupported script-open calendars retain focused direct date entry');
const disabledCalendar = controlled('web', '', { disabled: true });
[calendarInput] = disabledCalendar.render();
assert.equal(disabledCalendar.calendar().disabled, true);
disabledCalendar.calendar().onPress();
assert.equal(calendarInput.node.focused, 0, 'Disabled historical calendars cannot be opened');
assert.equal(calendarInput.node.opened, 0);
console.log('Kitchen visible calendar opener: native picker, unsupported-browser direct entry, disabled history passed');
