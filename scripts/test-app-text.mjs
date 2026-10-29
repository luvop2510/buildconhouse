import assert from 'node:assert/strict';
import { appTextFamily, systemTextFamily, WEB_SYSTEM_FONT_STACK } from '../src/components/appTextFamily.ts';

assert.equal(appTextFamily(), 'System');
assert.equal(appTextFamily(null), 'System');
for (const platform of ['ios', 'macos', 'android', 'web']) {
  const family = systemTextFamily(platform);
  for (const fontWeight of ['normal', '100', '400', 400, '500', 500, '600', 600, '700', '900', 'bold']) {
    assert.equal(appTextFamily({ fontWeight }, platform), family, 'weights must not introduce a second family');
  }
  assert.equal(appTextFamily({ fontFamily: 'feather' }, platform), 'feather', 'icons keep their own glyph face');
  assert.equal(appTextFamily({ fontFamily: 'inherit' }, platform), 'inherit', 'explicit inherited style is preserved');
}
assert.equal(systemTextFamily('ios'), 'System');
assert.equal(systemTextFamily('macos'), 'System');
assert.equal(systemTextFamily('android'), 'sans-serif');
assert.equal(systemTextFamily('web'), WEB_SYSTEM_FONT_STACK);
assert.match(WEB_SYSTEM_FONT_STACK, /^-apple-system, BlinkMacSystemFont, system-ui, sans-serif$/);
console.log('App text defaults passed: one system family across weights and platforms, icon glyphs preserved.');
