import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

function sourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}
let featherImports = 0;
for (const path of [...sourceFiles('app'), ...sourceFiles('src')]) {
  const source = readFileSync(path, 'utf8');
  if (!/AppText(?:\.native)?\.tsx$/.test(path)) {
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']react-native["']/g)) {
      assert.doesNotMatch(match[1], /(?:^|,)\s*(?:type\s+)?(?:Text|TextInput)(?:\s+as\s+\w+)?\s*(?=,|$)/, `${path} bypasses the app text defaults`);
    }
  }
  // Public family entry points let Metro exclude all unused glyph maps/fonts.
  assert.doesNotMatch(source, /(?:from\s*|require\(\s*)["']@expo\/vector-icons["']/, `${path} imports the whole Expo icon catalog`);
  const imports = [...source.matchAll(/from\s*["']@expo\/vector-icons\/([^"']+)["']/g)];
  for (const match of imports) assert.equal(match[1], 'Feather', `${path} uses an unregistered icon font`);
  // Text families must be Inter or inherit it. Icon families are registered
  // separately above and never replaced by the text-family contract.
  for (const match of source.matchAll(/fontFamily\s*:\s*["']([^"']+)["']/g)) {
    assert.ok(match[1] === 'inherit' || match[1].startsWith('Inter-'), `${path} declares text family ${match[1]}`);
  }
  assert.doesNotMatch(source, /["'](?:Fraunces[^"']*|Menlo|monospace|ui-monospace|Times New Roman|Georgia[^"']*)["']/, `${path} declares a second text family`);
  featherImports += imports.length;
}
assert.ok(featherImports > 0, 'canonical app still renders Feather icons');
const loader = readFileSync('src/hooks/use-app-fonts.ts', 'utf8');
assert.match(loader, /import Feather from "@expo\/vector-icons\/Feather"/);
assert.match(loader, /\.\.\.Feather\.font/);
assert.doesNotMatch(loader, /https?:|cdnIconUrl|ICON_VECTOR_VERSION/);
assert.match(loader, /import \{ INTER_FAMILY \} from "\.\/app-font-assets"/);
for (const path of ['src/hooks/app-font-assets.ts', 'src/hooks/app-font-assets.web.ts']) {
  const assets = readFileSync(path, 'utf8');
  for (const family of ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'Inter-Bold']) assert.ok(assets.includes(`"${family}"`), `${path}: ${family} must remain available`);
}
assert.doesNotMatch(loader, /Fraunces|FRAUNCES/, 'the app loads only Inter text fonts');
for (const path of ['src/design/tokens.ts', 'src/components/TempPasswordDialog.tsx', 'src/components/tiles/TilesDocBuilder.tsx']) {
  assert.doesNotMatch(readFileSync(path, 'utf8'), /"(?:Fraunces[^" ]*|Menlo|monospace|Times New Roman)"|Georgia,/, `${path} uses a second text family`);
}
const webLoader = readFileSync("src/hooks/use-app-fonts.web.ts", "utf8");
assert.match(webLoader, /document\.fonts\.load/);
assert.match(webLoader, /\.\.\.Feather\.font/);
console.log(`Icon/font contract passed: ${featherImports} public Feather imports, one bundled preloaded icon font, Inter only.`);
