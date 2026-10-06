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


// // Exclude unnecessary directories from file watching
// config.watchFolders = [__dirname];
// config.resolver.blacklistRE = /(.*)\/(__tests__|android|ios|build|dist|.git|node_modules\/.*\/android|node_modules\/.*\/ios|node_modules\/.*\/windows|node_modules\/.*\/macos)(\/.*)?$/;

// // Alternative: use a more aggressive exclusion pattern
// config.resolver.blacklistRE = /node_modules\/.*\/(android|ios|windows|macos|__tests__|\.git|.*\.android\.js|.*\.ios\.js)$/;

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
