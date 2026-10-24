import { createHash } from 'node:crypto';
import { readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const WEB_JS_PREFIX = '/_expo/static/js/web/';
const WEB_JS_REFERENCE = /(^|[\s"'`=(])\/_expo\/static\/js\/web\/([^\s"'`\\<>),}]+\.js)(?=[?#][^\s"'`\\<>),}]*|[\s"'`\\<>),}]|$)/g;

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function graphDigest(jsEntries) {
  const hash = createHash('sha256');
  for (const entry of [...jsEntries].sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0)) {
    hash.update(entry.relativePath);
    hash.update('\0');
    hash.update(entry.contents);
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 16);
}

function stampFilename(filename, digest) {
  return `${filename.slice(0, -3)}-g${digest}.js`;
}

function rewriteReferences(source, filenameMap, sourceLabel) {
  return source.replace(WEB_JS_REFERENCE, (match, prefix, referencedPath) => {
    const stampedPath = filenameMap.get(referencedPath);
    if (!stampedPath) {
      throw new Error(`${sourceLabel} references missing Expo web JavaScript asset: ${WEB_JS_PREFIX}${referencedPath}`);
    }
    return `${match.slice(0, prefix.length)}${WEB_JS_PREFIX}${stampedPath}`;
  });
}

/**
 * Give every emitted Expo web JavaScript file one graph-wide cache key.
 * Metro module IDs are allocated across the export and can be referenced by
 * multiple bundles, so every bundle needs the same graph cache identity.
 */
export async function isolateWebModuleGraph(exportRoot) {
  const webJsDirectory = join(exportRoot, '_expo', 'static', 'js', 'web');
  const allFiles = await walk(exportRoot);
  const jsFiles = allFiles.filter((path) => path.startsWith(`${webJsDirectory}/`) && path.endsWith('.js'));
  if (jsFiles.length === 0) throw new Error(`No Expo web JavaScript files found in ${webJsDirectory}`);

  const jsEntries = await Promise.all(jsFiles.map(async (path) => ({
    path,
    relativePath: relative(exportRoot, path).split('\\').join('/'),
    webRelativePath: relative(webJsDirectory, path).split('\\').join('/'),
    contents: await readFile(path),
  })));
  const digest = graphDigest(jsEntries);
  const filenameMap = new Map(jsEntries.map((entry) => [
    entry.webRelativePath,
    entry.webRelativePath.split('/').map((part, index, parts) => index === parts.length - 1 ? stampFilename(part, digest) : part).join('/'),
  ]));

  // Validate and prepare every rewritten file before changing the export.
  const preparedJs = jsEntries.map((entry) => ({
    ...entry,
    outputPath: join(webJsDirectory, filenameMap.get(entry.webRelativePath)),
    outputContents: Buffer.from(rewriteReferences(entry.contents.toString('utf8'), filenameMap, entry.relativePath)),
  }));
  const htmlFiles = allFiles.filter((path) => path.endsWith('.html'));
  const preparedHtml = await Promise.all(htmlFiles.map(async (path) => {
    const contents = await readFile(path, 'utf8');
    return { path, outputContents: rewriteReferences(contents, filenameMap, relative(exportRoot, path)) };
  }));

  const destinationPaths = new Set(preparedJs.map((entry) => entry.outputPath));
  const sourcePaths = new Set(jsFiles);
  for (const destination of destinationPaths) {
    if (allFiles.includes(destination) && !sourcePaths.has(destination)) {
      throw new Error(`Graph-stamped JavaScript filename collides with existing file: ${destination}`);
    }
  }

  // Rename first, then write transformed content under the new names. There
  // are no unstamped duplicate Expo bundles left in the uploaded export.
  for (const entry of preparedJs) await rename(entry.path, entry.outputPath);
  for (const entry of preparedJs) await writeFile(entry.outputPath, entry.outputContents);
  for (const entry of preparedHtml) await writeFile(entry.path, entry.outputContents);

  return { digest, files: preparedJs.length };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const exportRoot = process.argv[2] || 'dist/client';
  const result = await isolateWebModuleGraph(exportRoot);
  console.log(`Stamped ${result.files} Expo web JavaScript files with graph ${result.digest}.`);
}
