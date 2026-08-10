import OpenAI from 'openai';

/**
 * The single door to OpenAI. Every request in the app goes through createCompletion(),
 * which joins a global queue with exactly one request in flight at a time: the next
 * starts only after the previous one settles. The scan loop was already serialized in
 * MainView, but the fire-and-forget lesson card and an on-demand drill could still
 * overlap a scan; owning the client here (no module holds its own) makes overlap
 * structurally impossible rather than per-caller discipline.
 *
 * The waiting line has two lanes. Scan-lane work (solve/verify/confirm, and a drill
 * the learner tapped and is waiting on) always runs before background work (the
 * lesson card): pen-lift-to-verdict silence is the loop's tightest currency, and a
 * lesson card for problem N must never sit ahead of problem N+1's first solve. One
 * client, one in-flight request, unchanged; only the waiting order is new. Each
 * request stays bounded by the client timeout per attempt (the client retries once,
 * so a stalled call delays the queue by at most ~2x the timeout).
 */
let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing VITE_OPENAI_API_KEY. Copy .env.example to .env and add your key.');
    }
    // Reasoning models legitimately take 30-90s at medium/high effort, so the default
    // timeout is generous; callers pass a tighter per-request one where it fits (drill).
    client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true, timeout: 90000, maxRetries: 1 });
  }
  return client;
}

export type Lane = 'scan' | 'background';

let inFlight = false;
const pending: { lane: Lane; start: () => void }[] = [];

function pump(): void {
  if (inFlight || pending.length === 0) return;
  const i = pending.findIndex((j) => j.lane === 'scan');
  const job = pending.splice(i >= 0 ? i : 0, 1)[0];
  inFlight = true;
  job.start();
}

export function createCompletion(
  params: any,
  opts?: { timeout?: number; lane?: Lane },
): Promise<any> {
  return new Promise((resolve, reject) => {
    pending.push({
      lane: opts?.lane ?? 'scan',
      start: () => {
        let req: Promise<any>;
        try {
          req = getClient().chat.completions.create(
            params,
            opts?.timeout ? { timeout: opts.timeout } : undefined,
          );
        } catch (err) {
          // getClient can throw synchronously (missing key); the queue must survive it.
          inFlight = false;
          reject(err);
          pump();
          return;
        }
        req.then(resolve, reject).finally(() => {
          inFlight = false;
          pump();
        });
      },
    });
    pump();
  });
}

/**
 * Embeddings for the notebook's retrieval index. Same queue and the same one-in-flight
 * rule as everything else, on the background lane by default: indexing a folder must
 * never make the pen wait. Batched by the caller, since the endpoint takes an array.
 */
export function createEmbeddings(
  params: { model: string; input: string[] },
  opts?: { timeout?: number; lane?: Lane },
): Promise<any> {
  return new Promise((resolve, reject) => {
    pending.push({
      lane: opts?.lane ?? 'background',
      start: () => {
        let req: Promise<any>;
        try {
          req = getClient().embeddings.create(
            params,
            opts?.timeout ? { timeout: opts.timeout } : undefined,
          );
        } catch (err) {
          inFlight = false;
          reject(err);
          pump();
          return;
        }
        req.then(resolve, reject).finally(() => {
          inFlight = false;
          pump();
        });
      },
    });
    pump();
  });
}

// Strip control characters a model's broken JSON string escaping can smuggle past the
// strict schema: a live gpt-5.4 reply once mis-escaped the · in a problem label as
// backslash-u0000-b7, landing a literal NUL byte in the parsed string. Newlines and
// tabs stay: the solution checklist is line-structured.
export function cleanText(s: unknown): string {
  return typeof s === 'string' ? s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '') : '';
}

// Console probe: __nlApi() shows whether a request is running and how many wait behind
// it, per lane: the live proof (alongside the network tab) that requests never overlap
// and that a scan never waits behind a card.
if (typeof window !== 'undefined') {
  (window as unknown as { __nlApi: unknown }).__nlApi = () => ({
    inFlight,
    queued: pending.length,
    scan: pending.filter((j) => j.lane === 'scan').length,
    background: pending.filter((j) => j.lane === 'background').length,
  });
}
