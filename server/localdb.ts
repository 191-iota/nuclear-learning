import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import { docxMedia, docxToHtml } from './docx';

/**
 * The local file database, served by the dev server itself. Everything the app must
 * not lose (settings, lessons, skills, the Aufgaben archive, notes and their images)
 * lives as plain files under <repo>/data — OUTSIDE the browser profile — so clearing
 * browser data deletes nothing that matters; the next boot restores from disk.
 *
 * Design constraints:
 * - No extra process and no native dependencies: it rides the Vite server the app is
 *   already started with (dev AND preview), plain node:fs underneath.
 * - Files a human can read and back up: data/kv.json for the small key-value
 *   mirrors, one JSON file per archive/notes item, one .blob file per image.
 * - Atomic writes (tmp + rename), so a crash mid-write can never truncate a store.
 *
 * Endpoints (all JSON unless noted):
 *   GET    /api/db/health            → { ok: true }
 *   GET    /api/db/kv                → { key: value, ... }
 *   PUT    /api/db/kv                → body { entries: { key: value } }, merged
 *   GET    /api/db/col/:col          → array of item JSONs
 *   PUT    /api/db/col/:col/:id     → body = the item JSON
 *   DELETE /api/db/col/:col/:id     → removes item + its blob
 *   GET    /api/db/blob/:col/:id    → text body (a data URL)
 *   PUT    /api/db/blob/:col/:id    → text body (a data URL)
 *   GET    /api/db/file/:col/:id    → the same blob as RAW BYTES with its own
 *                                     content-type (?name= names it, ?dl=1 downloads)
 *   GET    /api/db/docx/:col/:id    → { html, text } for a stored Word document
 */

// 'vectors' holds the notebook's retrieval index (one JSON blob per note, see
// stores/retrieval.ts). It was missing here, so every write of an index 404ed and
// every read came back empty: the notebook re-embedded itself on each attach and each
// question, and answered from verbatim transcripts capped at 9000 characters. Both
// halves of that were paid for on every turn.
const COLS = new Set(['archive', 'notes', 'notefolders', 'chats', 'vectors']);
const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_BODY = 32 * 1024 * 1024; // localStorage tops out near 5 MB; images near 1 MB

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string, type = 'application/json'): void {
  res.statusCode = status;
  res.setHeader('content-type', `${type}; charset=utf-8`);
  res.end(body);
}

/**
 * Blobs are stored as data URLs (one text file per blob, readable and greppable).
 * Documents want their bytes back: a PDF has to reach the browser's own viewer, and
 * a .docx has to reach the reader in ./docx.
 */
function decodeDataUrl(s: string): { mime: string; bytes: Buffer } {
  const m = /^data:([^;,]*)(;base64)?,/.exec(s);
  if (!m) return { mime: 'application/octet-stream', bytes: Buffer.from(s, 'utf8') };
  const body = s.slice(m[0].length);
  return {
    mime: m[1] || 'application/octet-stream',
    bytes: m[2] ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8'),
  };
}

/** Quotes and control characters out: the name rides in a Content-Disposition header. */
function safeName(name: string): string {
  return name.replace(/[^\w.\- ()]+/g, '_').slice(0, 120) || 'document';
}

function writeAtomic(file: string, content: string): void {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

export function localDb(dataDir: string): Plugin {
  fs.mkdirSync(dataDir, { recursive: true });
  const kvFile = path.join(dataDir, 'kv.json');

  function colDir(col: string): string {
    const dir = path.join(dataDir, col);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  function readKv(): Record<string, string> {
    try {
      return JSON.parse(fs.readFileSync(kvFile, 'utf8')) as Record<string, string>;
    } catch {
      return {};
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith('/api/db/')) return false;
    const parts = url.pathname.slice('/api/db/'.length).split('/').filter(Boolean);
    const method = req.method ?? 'GET';

    try {
      if (parts[0] === 'health' && method === 'GET') {
        send(res, 200, JSON.stringify({ ok: true }));
        return true;
      }

      if (parts[0] === 'kv') {
        if (method === 'GET') {
          send(res, 200, JSON.stringify(readKv()));
          return true;
        }
        if (method === 'PUT') {
          const body = JSON.parse(await readBody(req)) as { entries?: Record<string, string> };
          const entries = body.entries ?? {};
          const kv = readKv();
          for (const [k, v] of Object.entries(entries)) {
            if (typeof k === 'string' && typeof v === 'string' && k.length < 200) kv[k] = v;
          }
          writeAtomic(kvFile, JSON.stringify(kv));
          send(res, 200, JSON.stringify({ ok: true }));
          return true;
        }
      }

      if (parts[0] === 'col' && parts[1] && COLS.has(parts[1])) {
        const dir = colDir(parts[1]);
        if (method === 'GET' && parts.length === 2) {
          const items: unknown[] = [];
          for (const f of fs.readdirSync(dir)) {
            if (!f.endsWith('.json')) continue;
            try {
              items.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
            } catch {
              // one corrupt item must never take the whole collection down
            }
          }
          send(res, 200, JSON.stringify(items));
          return true;
        }
        if (parts.length === 3 && ID_RE.test(parts[2])) {
          const file = path.join(dir, `${parts[2]}.json`);
          if (method === 'PUT') {
            const body = await readBody(req);
            JSON.parse(body); // reject non-JSON before it lands on disk
            writeAtomic(file, body);
            send(res, 200, JSON.stringify({ ok: true }));
            return true;
          }
          if (method === 'DELETE') {
            fs.rmSync(file, { force: true });
            fs.rmSync(path.join(dir, `${parts[2]}.blob`), { force: true });
            send(res, 200, JSON.stringify({ ok: true }));
            return true;
          }
        }
      }

      if (parts[0] === 'blob' && parts[1] && COLS.has(parts[1]) && parts[2] && ID_RE.test(parts[2])) {
        const file = path.join(colDir(parts[1]), `${parts[2]}.blob`);
        if (method === 'GET') {
          if (!fs.existsSync(file)) {
            send(res, 404, JSON.stringify({ error: 'not found' }));
            return true;
          }
          send(res, 200, fs.readFileSync(file, 'utf8'), 'text/plain');
          return true;
        }
        if (method === 'PUT') {
          writeAtomic(file, await readBody(req));
          send(res, 200, JSON.stringify({ ok: true }));
          return true;
        }
      }

      // A stored document, served as itself: the browser's PDF viewer and the
      // Download link both need real bytes and a real content-type, which a data URL
      // in a text file cannot give them.
      if (parts[0] === 'file' && parts[1] && COLS.has(parts[1]) && parts[2] && ID_RE.test(parts[2]) && method === 'GET') {
        const file = path.join(colDir(parts[1]), `${parts[2]}.blob`);
        if (!fs.existsSync(file)) {
          send(res, 404, JSON.stringify({ error: 'not found' }));
          return true;
        }
        const { mime, bytes } = decodeDataUrl(fs.readFileSync(file, 'utf8'));
        const name = safeName(url.searchParams.get('name') ?? parts[2]);
        res.statusCode = 200;
        res.setHeader('content-type', mime);
        res.setHeader('content-length', String(bytes.length));
        res.setHeader(
          'content-disposition',
          `${url.searchParams.get('dl') ? 'attachment' : 'inline'}; filename="${name}"`,
        );
        res.end(bytes);
        return true;
      }

      if (parts[0] === 'docx' && parts[1] && COLS.has(parts[1]) && parts[2] && ID_RE.test(parts[2]) && method === 'GET') {
        const file = path.join(colDir(parts[1]), `${parts[2]}.blob`);
        if (!fs.existsSync(file)) {
          send(res, 404, JSON.stringify({ error: 'not found' }));
          return true;
        }
        try {
          const { bytes } = decodeDataUrl(fs.readFileSync(file, 'utf8'));
          // Pictures stay in the archive and are fetched one by one from the route
          // below, so the converted HTML is kilobytes even for an illustrated thesis.
          const view = docxToHtml(bytes, `/api/db/docmedia/${parts[1]}/${parts[2]}?p=`);
          send(res, 200, JSON.stringify(view));
        } catch (err) {
          send(res, 422, JSON.stringify({ error: String(err) }));
        }
        return true;
      }

      if (parts[0] === 'docmedia' && parts[1] && COLS.has(parts[1]) && parts[2] && ID_RE.test(parts[2]) && method === 'GET') {
        const file = path.join(colDir(parts[1]), `${parts[2]}.blob`);
        const inner = url.searchParams.get('p') ?? '';
        if (!fs.existsSync(file)) {
          send(res, 404, JSON.stringify({ error: 'not found' }));
          return true;
        }
        const { bytes } = decodeDataUrl(fs.readFileSync(file, 'utf8'));
        const media = docxMedia(bytes, inner);
        if (!media) {
          send(res, 404, JSON.stringify({ error: 'no such picture' }));
          return true;
        }
        res.statusCode = 200;
        res.setHeader('content-type', media.mime);
        res.setHeader('content-length', String(media.bytes.length));
        res.setHeader('cache-control', 'private, max-age=300');
        res.end(media.bytes);
        return true;
      }

      send(res, 404, JSON.stringify({ error: 'unknown route' }));
      return true;
    } catch (err) {
      send(res, 500, JSON.stringify({ error: String(err) }));
      return true;
    }
  }

  const attach = (middlewares: { use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void }) => {
    middlewares.use((req, res, next) => {
      void handle(req, res).then((handled) => {
        if (!handled) next();
      });
    });
  };

  return {
    name: 'nuclear-learning-localdb',
    configureServer(server) {
      attach(server.middlewares);
    },
    // `vite preview` serves the built app; the database must exist there too.
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
