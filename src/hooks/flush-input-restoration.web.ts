// This timer integrates DOM focus/pointer events with React. Commit restored
// chrome before another browser event can select a target using stale geometry.
// Keep react-dom out of the native module through platform resolution.
// The package has no bundled TypeScript declarations; type this single DOM API.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { flushSync } = require("react-dom") as { flushSync: (update: () => void) => void };
export function flushInputRestoration(update: () => void) { flushSync(update); }
