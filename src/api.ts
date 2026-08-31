import OpenAI from 'openai';

/**
 * The single door to the model server, which is this machine. Ollama answers on an
 * OpenAI-shaped endpoint, so the client library stays and only the address moves:
 * VITE_OLLAMA_BASE_URL, or http://127.0.0.1:11434/v1 when nothing is set. No page,
 * transcript or question leaves the laptop, which is also why there is no key here to
 * hold or to rotate; the client refuses an empty one, and that is all the placeholder
 * below is for.
 *
 * Every request in the app goes through createCompletion(), which joins a global queue
 * with exactly one request in flight at a time: the next starts only after the previous
 * one settles. That rule was written to stop a fire-and-forget lesson card overlapping a
 * scan, and it carries its weight twice over now that the model is local: one GPU, one
 * loaded model, and a second request in flight would only take memory from the first.
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

const BASE_URL = import.meta.env.VITE_OLLAMA_BASE_URL || 'http://127.0.0.1:11434/v1';

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: BASE_URL,
      // Ollama neither reads nor needs one; the client insists on a non-empty string.
      apiKey: 'ollama',
      dangerouslyAllowBrowser: true,
      // A local answer usually lands in seconds, but the first request after a boot
      // waits for the weights to be read off disk, and a page sent to a thinking model
      // can run for a minute on its own. Callers pass a tighter one where it fits.
      timeout: 180000,
      maxRetries: 1,
    });
  }
  return client;
}

/**
 * What a request needs on the way out that it did not when it was billed by the token.
 *
 * `reasoning_effort` is never left off. Ollama reads it as how long the model thinks
 * before it answers, and leaving it out does not mean no thinking, it means the model's
 * own default, which is to think. On a page of handwriting that costs about five times
 * the wall clock and reads the page no better (gemma4:e4b: 7s against 35s on the same
 * page, and the fast one was the accurate one). Deliberation is worth asking for by
 * name where it pays, and it should never arrive by omission.
 *
 * `max_completion_tokens` is the hosted spelling and Ollama ignores it, so the same
 * ceiling goes out as `max_tokens` too. Without it a model that starts repeating itself
 * runs until the timeout rather than stopping at the ceiling the caller set.
 */
function shape(params: any): any {
  const out = { ...params };
  if (out.reasoning_effort === undefined) out.reasoning_effort = 'none';
  if (out.max_tokens === undefined && out.max_completion_tokens !== undefined) {
    out.max_tokens = out.max_completion_tokens;
  }
  return out;
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
            shape(params),
            opts?.timeout ? { timeout: opts.timeout } : undefined,
          );
        } catch (err) {
          // getClient can throw synchronously; the queue must survive it.
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
 * Embeddings for the notebook's retrieval index, from the small embedding model beside
 * the big one (settings.api.embedModel). Same queue and the same one-in-flight rule as
 * everything else, on the background lane by default: indexing a folder must never make
 * the pen wait, and it must never take the GPU from a page that is being read. Batched
 * by the caller, since the endpoint takes an array.
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
// strict schema: a live reply once mis-escaped the · in a problem label as
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
    baseUrl: BASE_URL,
    inFlight,
    queued: pending.length,
    scan: pending.filter((j) => j.lane === 'scan').length,
    background: pending.filter((j) => j.lane === 'background').length,
  });
}
