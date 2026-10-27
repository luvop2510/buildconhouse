import { readFile } from 'node:fs/promises';
import { sessionCookies } from './session-cookies.cjs';

// Browser workers upload as one file. Vercel's Node loader instead requires a
// CommonJS helper. Both receive exactly the same canonical cookie function.
export async function standaloneWorkerSource() {
  const source = await readFile(new URL('./web-worker.mjs', import.meta.url), 'utf8');
  const cookieImport = "import { sessionCookies } from './session-cookies.cjs';";
  if (!source.includes(cookieImport)) throw new Error('Missing canonical cookie helper import');
  return source.replace(cookieImport, sessionCookies.toString());
}
