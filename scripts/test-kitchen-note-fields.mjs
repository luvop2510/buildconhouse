import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const React = require('react');
let platform;
let values;
let cursor;
let effects;
let node;
const host = name => name;
const mocks = {
  react: { ...React,
    useId: () => 'notes', useCallback: callback => callback,
    useState(initial) { const index = cursor++; if (!(index in values)) values[index] = initial; return [values[index], value => { values[index] = typeof value === 'function' ? value(values[index]) : value; }]; },
    useRef: () => ({ current: node }), useLayoutEffect: effect => effects.push(effect),
  },
  'react-native': { Platform: { get OS() { return platform; } }, View: host('view'), Pressable: host('button') },
  '@expo/vector-icons/Feather': host('icon'),
  '@/src/components/AppText': { Text: host('text'), TextInput: host('input') },
  '@/src/components/ui': {},
  '@/src/theme/tokens': { colors: {}, type: { body: {} } },
  '@/src/design/responsive': { useBp: () => ({ isPhone: true }) },
};
const source = await readFile(new URL('../src/components/kitchen/KitchenPrimitives.tsx', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
const exports = {};
new Function('require', 'exports', compiled)(name => mocks[name] || require(name), exports);
function mount(os) {
  platform = os; values = [];
  node = { style: {}, measured: 46, get scrollHeight() { assert.equal(this.style.height, '0px', 'reset height before measuring, including when shrinking'); return this.measured; } };
}
function flatten(element) {
  if (!element || typeof element !== 'object') return [];
  if (Array.isArray(element)) return element.flatMap(flatten);
  return [element, ...flatten(element.props.children)];
}
function render(props) {
  cursor = 0; effects = [];
  const field = flatten(exports.KitchenTextField(props)).find(element => element.type === 'input');
  effects.forEach(effect => effect());
  return field.props;
}
const props = { label: 'Installation notes', value: '', multiline: true, helper: 'Optional notes' };
mount('web');
let field = render(props);
assert.equal(field.style[0].height, 46, 'an empty note starts at one line');
assert.equal(field.numberOfLines, 1);
assert.equal(field.scrollEnabled, false, 'the field grows instead of hiding text behind a scrollbar');
assert.equal(field.accessibilityLabel, props.label);
assert.equal(field['aria-labelledby'], 'notes-label');
assert.equal(field['aria-describedby'], 'notes-description');
node.measured = 166;
render({ ...props, value: 'A long prefilled note\nwith several lines' });
assert.equal(render(props).style[0].height, 166, 'saved and edited long notes grow');
node.measured = 46;
render({ ...props, value: '' });
assert.equal(render(props).style[0].height, 46, 'clearing a long note shrinks it to one line');
let layout;
field = render({ ...props, onLayout: event => { layout = event; } });
node.measured = 94;
const widthChange = { nativeEvent: { layout: { width: 280 } } };
field.onLayout(widthChange);
assert.equal(layout, widthChange, 'caller layout behavior is preserved');
assert.equal(render(props).style[0].height, 94, 'narrowing a field measures wrapped content');
node.measured = 46;
field.onLayout({ nativeEvent: { layout: { width: 820 } } });
assert.equal(render(props).style[0].height, 46, 'widening the field shrinks wrapped notes');
mount('ios');
let contentEvent;
field = render({ ...props, onContentSizeChange: event => { contentEvent = event; } });
const longContent = { nativeEvent: { contentSize: { height: 93.2 } } };
field.onContentSizeChange(longContent);
assert.equal(contentEvent, longContent);
assert.equal(render(props).style[0].height, 94, 'native content measurement grows without clipping fractional pixels');
field.onContentSizeChange({ nativeEvent: { contentSize: { height: 24 } } });
assert.equal(render(props).style[0].height, 46, 'native empty content retains the touch target');
field = render({ label: 'Amount', multiline: false, numberOfLines: 3, scrollEnabled: true });
assert.equal(field.style[0].height, undefined, 'non-text controls retain their existing sizing');
assert.equal(field.numberOfLines, 3);
assert.equal(field.scrollEnabled, true);
console.log('Kitchen note fields: compact baseline, content growth/shrink, resize, native sizing and accessible labels passed');
