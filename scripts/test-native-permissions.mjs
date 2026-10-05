import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Exercise Expo plugins, not just app.json: expo-audio previously injected an
// unused iOS microphone declaration even when Android recording was disabled.
const result = spawnSync('npx', ['expo', 'config', '--type', 'introspect', '--json'], {
  encoding: 'utf8', env: { ...process.env, EXPO_NO_DOTENV: '1' }, maxBuffer: 16 * 1024 * 1024,
});
assert.equal(result.status, 0, 'Expo permission introspection must succeed');
const config = JSON.parse(result.stdout);
const plist = config._internal.modResults.ios.infoPlist;
const permissions = config._internal.modResults.android.manifest.manifest['uses-permission'] || [];
assert.equal(plist.NSMicrophoneUsageDescription, undefined, 'Selection sounds must not require microphone access');
assert.equal(plist.NSCameraUsageDescription, undefined, 'Library-only images must not request camera access');
const forbidden = new Set(config.android.blockedPermissions);
for (const permission of permissions) {
  const value = permission.$;
  assert(!forbidden.has(value['android:name']) || value['tools:node'] === 'remove', 'Blocked Android permissions must remain removed after plugins run');
}
console.log('Expo iOS/Android plugin introspection: camera, microphone and blocked media/location permission checks passed');
