import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const tokens = readFileSync(new URL('../src/design/tokens.ts', import.meta.url), 'utf8');
const palette = Object.fromEntries([...tokens.matchAll(/(\w+):\s*"(#[\da-f]{6})"/gi)].map(([, key, value]) => [key, value]));
function luminance(hex) {
  const values = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return values.reduce((sum, value, i) => sum + value * [.2126, .7152, .0722][i], 0);
}
for (const [foreground, background] of [['ink', 'canvas'], ['ink2', 'canvas'], ['ink3', 'canvas'], ['brass', 'white'], ['ok', 'okTint'], ['warn', 'warnTint'], ['risk', 'riskTint']]) {
  const [dark, light] = [luminance(palette[foreground]), luminance(palette[background])].sort((a, b) => a - b);
  const contrast = (light + .05) / (dark + .05);
  assert(contrast >= 4.5, `${foreground} on ${background} must meet AA for normal text; received ${contrast.toFixed(2)}:1`);
  console.log(`${foreground}/${background}: ${contrast.toFixed(2)}:1 (AA)`);
}
