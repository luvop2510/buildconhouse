import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// Exercise Expo's actual consumers after the scoped Zod security override.
const require = createRequire(import.meta.url);
const expoRequire = createRequire(require.resolve('expo/package.json'));
const cliPackage = expoRequire.resolve('@expo/cli/package.json');
const cliRequire = createRequire(cliPackage);
const server = join(dirname(cliPackage), 'build/src/start/server');
const { z } = cliRequire('zod');
const { PluginSchema, DevToolsPluginOutputSchema } = require(join(server, 'DevToolsPlugin.schema.js'));
const { createMCPDevToolsExtensionSchema } = require(join(server, 'createMCPDevToolsExtensionSchema.js'));
const { DevToolsPlugin } = require(join(server, 'DevToolsPlugin.js'));
const { DevToolsPluginCliExtensionResults } = require(join(server, 'DevToolsPluginCliExtensionResults.js'));
assert.equal(cliRequire('zod/package.json').version, '4.6.7');
assert.equal(cliRequire('node-forge/package.json').version, '1.4.1');

const plugin = {
  packageName: 'schema-compatibility-check', packageRoot: '/tmp/schema-compatibility-check',
  cliExtensions: {
    description: 'Compatibility fixture', entryPoint: 'index.js',
    commands: [{ name: 'run', title: 'Run command', environments: ['cli', 'mcp'], parameters: [
      { name: 'label', type: 'text' }, { name: 'count', type: 'number' }, { name: 'confirmed', type: 'confirm' },
    ] }],
  },
};
assert.equal(new DevToolsPlugin(plugin, '/tmp').packageName, plugin.packageName);
assert.throws(() => new DevToolsPlugin({}, '/tmp'), error => error.message.startsWith('Invalid plugin configuration:') && error.cause.issues.length > 0);
const parsedPlugin = PluginSchema.safeParse(plugin);
assert.equal(parsedPlugin.success, true);
assert.equal(Object.isFrozen(parsedPlugin.data.cliExtensions.commands[0].environments), true);
for (const invalid of [{}, { ...plugin, packageName: '' }, { ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [] } },
  { ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [{ ...plugin.cliExtensions.commands[0], environments: ['unsupported'] }] } }]) {
  const result = PluginSchema.safeParse(invalid);
  assert.equal(result.success, false);
  assert.ok(result.error.message.length);
  assert.ok(result.error.issues.every(issue => issue.message.length));
}
const schema = createMCPDevToolsExtensionSchema(plugin);
for (const input of [{ command: 'run' }, { command: 'run', label: 'Example', count: 2, confirmed: true }]) {
  assert.equal(schema.safeParse(input).success, true);
}
for (const input of [{}, { command: 'other' }, { command: 'run', count: '2' }, { command: 'run', confirmed: 'yes' }, { command: 'run', extra: 1 }]) {
  assert.equal(schema.safeParse(input).success, false);
}
assert.throws(() => createMCPDevToolsExtensionSchema({ ...plugin, cliExtensions: undefined }), /no commands defined/);
const json = z.toJSONSchema(schema);
assert.equal(json.additionalProperties, false);
assert.deepEqual(json.required, ['command']);
assert.deepEqual(json.properties.command.enum, ['run']);
assert.equal(json.properties.count.type, 'number');

const output = [{ type: 'text', text: 'hello', level: 'info' }, { type: 'audio', url: 'https://example.test/audio' }, { type: 'image', url: 'https://example.test/image', text: 'image' }];
assert.equal(DevToolsPluginOutputSchema.safeParse(output).success, true);
for (const invalid of [[{ type: 'text', text: 'bad', level: 'debug' }], [{ type: 'audio', url: 'invalid' }], [{ type: 'image', url: 'invalid' }]]) {
  assert.equal(DevToolsPluginOutputSchema.safeParse(invalid).success, false);
}
const results = new DevToolsPluginCliExtensionResults();
assert.deepEqual(results.parseOutputText(JSON.stringify(output)), output);
assert.equal(results.parseOutputText('[{"type":"audio","url":"invalid"}]')[0].level, 'error');
assert.equal(results.parseOutputText('plain\ntext').length, 2);
console.log('Installed Expo CLI schemas: plugin/commands/output parsing and Zod4 JSON schema compatibility passed; patched dependency versions verified.');
