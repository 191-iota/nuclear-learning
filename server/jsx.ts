import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/**
 * The compiler behind a widget on the board: JSX in, plain JavaScript out.
 *
 * A browser has no way of running JSX by itself, and every transpiler that fits in a
 * page weighs a megabyte or more, which is a great deal of parser to ship for
 * something used a few times a week. This app already needs its dev server (the file
 * database rides it), and Vite's bundler carries oxc, which is that parser compiled
 * to native code. So the compile costs no new dependency and takes about a
 * millisecond.
 *
 *   POST /api/jsx   body { source }  ->  { code } | { error }
 *
 * Transforming is all that happens here. Nothing is written and nothing is executed:
 * the compiled JavaScript goes straight back to the page that asked for it, and the
 * page is where it runs.
 */

const MAX_SOURCE = 400_000;
const ANSI = /\u001b\[[0-9;]*m/g; // oxc colours its diagnostics for a terminal

interface TransformResult {
  code?: string;
  errors?: unknown[];
}
type TransformSync = (filename: string, source: string, options?: unknown) => TransformResult;

// rolldown arrives inside vite rather than as a dependency of ours, so the compiler
// is looked up once at the first request. If a future vite stops carrying it, widgets
// report a compile error and the rest of the app is untouched, which is better than a
// dev server that refuses to boot.
let cached: Promise<TransformSync | null> | null = null;

function compiler(): Promise<TransformSync | null> {
  cached ??= import('rolldown/experimental')
    .then((m) => (m as { transformSync?: TransformSync }).transformSync ?? null)
    .catch(() => null);
  return cached;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_SOURCE) {
        reject(new Error('the source is too long to compile'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(body);
}

/**
 * One line a person can act on, out of a diagnostic built for a terminal: oxc's
 * message carries colour codes and a drawn code frame under it, and the frame is
 * redundant here because the source is on screen beside the error.
 */
function readable(err: unknown): string {
  const raw =
    typeof err === 'string' ? err : String((err as { message?: unknown } | null)?.message ?? err);
  const clean = raw.replace(ANSI, '');
  const first = (clean.split('\n').find((l) => l.trim()) ?? 'Could not compile this').trim();
  const text = first.replace(/^\[[A-Z_]+\]\s*/, '');
  const at = /widget\.jsx:(\d+):(\d+)/.exec(clean);
  return at ? `Line ${at[1]}, column ${at[2]}: ${text}` : text;
}

export function jsxCompiler(): Plugin {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = req.url ?? '';
    if (url !== '/api/jsx' && !url.startsWith('/api/jsx?')) return false;
    if (req.method !== 'POST') {
      send(res, 405, JSON.stringify({ error: 'POST a { source } body here.' }));
      return true;
    }
    try {
      const body = await readBody(req);
      const source = String((JSON.parse(body || '{}') as { source?: unknown }).source ?? '');
      if (!source.trim()) {
        send(res, 200, JSON.stringify({ code: '' }));
        return true;
      }
      const transform = await compiler();
      if (!transform) {
        send(
          res,
          200,
          JSON.stringify({
            error: 'No JSX compiler in this install. Reinstall dependencies (npm install).',
          }),
        );
        return true;
      }
      // The automatic runtime makes the compiled code IMPORT what it needs instead of
      // assuming an `h` is already in scope, which is what lets the page hand it a
      // runtime by rewriting a single import specifier. `react` is the import source
      // every JSX author writes against, so that is the name the page maps.
      const out = transform('widget.jsx', source, {
        jsx: { runtime: 'automatic', importSource: 'react' },
      });
      const errors = out.errors ?? [];
      if (errors.length) {
        send(res, 200, JSON.stringify({ error: readable(errors[0]) }));
        return true;
      }
      send(res, 200, JSON.stringify({ code: out.code ?? '' }));
    } catch (err) {
      send(res, 200, JSON.stringify({ error: readable(err) }));
    }
    return true;
  }

  const attach = (middlewares: {
    use: (fn: (req: IncomingMessage, res: ServerResponse, next: () => void) => void) => void;
  }): void => {
    middlewares.use((req, res, next) => {
      void handle(req, res).then((handled) => {
        if (!handled) next();
      });
    });
  };

  return {
    name: 'nuclear-learning-jsx',
    configureServer(server) {
      attach(server.middlewares);
    },
    // `vite preview` serves the built app, where widgets have to keep working.
    configurePreviewServer(server) {
      attach(server.middlewares);
    },
  };
}
