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
  // Public family entry points let Metro exclude all unused glyph maps/fonts.
  assert.doesNotMatch(source, /(?:from\s*|require\(\s*)["']@expo\/vector-icons["']/, `${path} imports the whole Expo icon catalog`);
  const imports = [...source.matchAll(/from\s*["']@expo\/vector-icons\/([^"']+)["']/g)];
  for (const match of imports) assert.equal(match[1], 'Feather', `${path} uses an unregistered icon font`);
  featherImports += imports.length;
}
assert.ok(featherImports > 0, 'canonical app still renders Feather icons');
const loader = readFileSync('src/hooks/use-app-fonts.ts', 'utf8');
assert.match(loader, /const ICON_FAMILIES: Record<string, string> = \{ feather: "Feather" \};/);
for (const family of ['Inter-Regular', 'Inter-Medium', 'Inter-SemiBold', 'Inter-Bold', 'Fraunces-Light', 'Fraunces-LightItalic', 'Fraunces-Regular']) assert.ok(loader.includes(`"${family}"`), `${family} must remain available`);
assert.match(loader, /ExecutionEnvironment\.StoreClient\s*\? iconFontMap\(\)/);
console.log(`Icon/font contract passed: ${featherImports} public Feather imports, one Expo Go icon font, Inter/Fraunces preserved.`);
