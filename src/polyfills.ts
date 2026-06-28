// web_pen_sdk is a webpack CommonJS bundle that references the Node `global`
// identifier at runtime. Define it as a property of the global object before the
// SDK is evaluated. Imported first in main.ts (ES module imports are evaluated in
// source order), so this runs before web_pen_sdk is pulled in transitively.
const g = globalThis as unknown as {
  global?: unknown;
  process?: { env: Record<string, unknown> };
};
if (g.global === undefined) {
  g.global = globalThis;
}
// Firebase / JSZip inside web_pen_sdk read `process.env` at module-eval time.
// Provide a minimal browser shim. `env` only, no `process.versions`, so libs
// that feature-detect Node correctly stay on their browser code paths.
if (g.process === undefined) {
  g.process = { env: {} };
}

export {};
