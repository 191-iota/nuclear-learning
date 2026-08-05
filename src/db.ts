import { reactive } from 'vue';

/**
 * Client for the dev server's file database (see server/localdb.ts). Availability is
 * probed once at boot (main.ts awaits it before the stores load); a build served
 * without the middleware simply reports unavailable and the app runs on its
 * in-browser storage as before.
 */

const BASE = '/api/db';

export const dbState = reactive({
  available: false,
  checked: false,
});

export async function checkDb(): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${BASE}/health`, { signal: ctrl.signal });
    window.clearTimeout(t);
    dbState.available = res.ok;
  } catch {
    dbState.available = false;
  }
  dbState.checked = true;
  return dbState.available;
}

async function ok(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`db ${res.status}: ${await res.text().catch(() => '')}`);
  return res;
}

export async function kvGetAll(): Promise<Record<string, string>> {
  const res = await ok(await fetch(`${BASE}/kv`));
  return (await res.json()) as Record<string, string>;
}

export async function kvPut(entries: Record<string, string>, keepalive = false): Promise<void> {
  const body = JSON.stringify({ entries });
  await ok(
    await fetch(`${BASE}/kv`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body,
      // keepalive survives tab close but caps the payload (~64 KB); callers pass it
      // only for small unload-time deltas.
      keepalive: keepalive && body.length < 60_000,
    }),
  );
}

export async function colList<T>(col: string): Promise<T[]> {
  const res = await ok(await fetch(`${BASE}/col/${col}`));
  return (await res.json()) as T[];
}

export async function colPut(col: string, id: string, item: unknown): Promise<void> {
  await ok(
    await fetch(`${BASE}/col/${col}/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(item),
    }),
  );
}

export async function colDelete(col: string, id: string): Promise<void> {
  await ok(await fetch(`${BASE}/col/${col}/${id}`, { method: 'DELETE' }));
}

export async function blobGet(col: string, id: string): Promise<string> {
  const res = await fetch(`${BASE}/blob/${col}/${id}`);
  if (res.status === 404) return '';
  await ok(res);
  return res.text();
}

export async function blobPut(col: string, id: string, dataUrl: string): Promise<void> {
  await ok(
    await fetch(`${BASE}/blob/${col}/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/plain' },
      body: dataUrl,
    }),
  );
}
