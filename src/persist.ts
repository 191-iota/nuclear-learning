import { checkDb, dbState, kvGetAll, kvPut } from '@/db';

/**
 * The localStorage mirror. The stores keep reading and writing localStorage
 * synchronously (their boot depends on it), and this module makes that durable:
 *
 * - restoreMirror(), awaited in main.ts BEFORE the store modules load: any nl.* key
 *   present on disk but missing in localStorage is written back. After a browser
 *   data wipe the whole state (settings, presets, lessons, skills, usage) reappears.
 *   An existing localStorage value always wins — the browser copy is never older
 *   than the disk copy it itself produced.
 *
 * - startMirror(): every 20 s, on tab-hide, and on unload, the nl.* keys that
 *   changed since the last push are written to disk. Content-diffed per key, so the
 *   steady-state cost is one no-op scan.
 */

const PREFIX = 'nl.';
const SYNC_MS = 20_000;

const lastPushed = new Map<string, string>();

export async function restoreMirror(): Promise<void> {
  const available = await checkDb();
  if (!available) return;
  try {
    const disk = await kvGetAll();
    for (const [k, v] of Object.entries(disk)) {
      if (!k.startsWith(PREFIX) || typeof v !== 'string') continue;
      if (localStorage.getItem(k) === null) localStorage.setItem(k, v);
      // Baseline = the disk copy: a browser value that differs gets pushed on the
      // first sync tick.
      lastPushed.set(k, v);
    }
  } catch (err) {
    console.warn('[nuclear-learning] disk restore failed:', err);
  }
}

function collect(): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (k && k.startsWith(PREFIX)) out[k] = localStorage.getItem(k) ?? '';
  }
  return out;
}

async function syncNow(keepalive = false): Promise<void> {
  if (!dbState.available) return;
  const delta: Record<string, string> = {};
  for (const [k, v] of Object.entries(collect())) {
    if (lastPushed.get(k) !== v) delta[k] = v;
  }
  if (Object.keys(delta).length === 0) return;
  try {
    await kvPut(delta, keepalive);
    for (const [k, v] of Object.entries(delta)) lastPushed.set(k, v);
  } catch (err) {
    console.warn('[nuclear-learning] disk sync failed:', err);
  }
}

export function startMirror(): void {
  if (!dbState.available) {
    console.warn(
      '[nuclear-learning] file database unreachable — state stays in browser storage only. Run the app through `npm run dev` (or preview) for durable data.',
    );
    return;
  }
  window.setInterval(() => {
    void syncNow();
  }, SYNC_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void syncNow();
  });
  window.addEventListener('beforeunload', () => {
    void syncNow(true);
  });
}
