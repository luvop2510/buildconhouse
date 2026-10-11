// metro.config.js
const { getDefaultConfig } = require("expo/metro-config");
const path = require('path');
const { FileStore } = require('metro-cache');
const { resolve } = require("metro-resolver");

const config = getDefaultConfig(__dirname);
// Only the web font map imports WOFF2; native builds resolve its TTF sibling.
if (!config.resolver.assetExts.includes('woff2')) config.resolver.assetExts.push('woff2');

// Use a stable on-disk store (shared across web/android)
const root = process.env.METRO_CACHE_ROOT || path.join(__dirname, '.metro-cache');
config.cacheStores = [
  new FileStore({ root: path.join(root, 'cache') }),
];


// Releases use the root app/src. Do not crawl the preserved legacy checkout,
// Python backend/venvs, or gigabytes of generated browser evidence on startup.
// Preserve Metro's default exclusions and scope ours to top-level directories
// so package source and active app assets remain resolvable on every platform.
const excludedDirectories = [
  'frontend', 'backend', 'output', 'dist', 'audit-evidence', 'test-results',
  'test_reports', 'memory', 'tmp', '.git', '.venv', '.screenshots', '.playwright-cli',
];
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const existingBlockList = config.resolver.blockList;
config.resolver.blockList = [
  ...(Array.isArray(existingBlockList) ? existingBlockList : existingBlockList ? [existingBlockList] : []),
  ...excludedDirectories.map((directory) => new RegExp(`^${escapePattern(path.join(__dirname, directory))}(?:[/\\\\].*)?$`)),
];

// Reduce the number of workers to decrease resource usage
config.maxWorkers = 2;

const webOnlyShims = {
  "react-native-reanimated": path.join(__dirname, "src/web/shims/react-native-reanimated.js"),
  "react-native-gesture-handler": path.join(__dirname, "src/web/shims/react-native-gesture-handler.js"),
  "@sentry/react-native": path.join(__dirname, "src/web/shims/sentry-react-native.js"),
};
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (platform === "web" && webOnlyShims[moduleName]) {
    return { type: "sourceFile", filePath: webOnlyShims[moduleName] };
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
