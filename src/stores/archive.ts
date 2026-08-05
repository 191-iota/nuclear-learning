import { reactive, ref } from 'vue';
import { cleanText, createCompletion } from '@/api';
import { recordUsage } from '@/stores/usage';
import { blobGet, blobPut, colDelete, colList, colPut, dbState } from '@/db';

/**
 * The Aufgaben archive: every problem the pad has seen, stored and findable again.
 *
 * A page lands here automatically the moment a finish check says CORRECT, or by
 * hand via the Archive button (verdict 'open'). Each entry keeps the graded image,
 * the statement of record, the label, and the internal reference solution — plus a
 * search index (title, description, topics, keywords) written by one cheap
 * background model call, so "bruchgleichung parameter" finds the right page months
 * later without anyone ever tagging by hand.
 *
 * Storage is the dev server's file database (data/archive/*.json + *.blob): real
 * files outside the browser profile, so clearing browser data loses nothing. The
 * first boot after this change imports everything from the previous IndexedDB store
 * one time; without the file database (a statically served build) the archive is
 * session-memory only and says so once in the console.
 *
 * Console access: __nlArchive()
 */

export interface ArchivedAufgabe {
  id: string;
  ts: number;
  modeId: string;
  modeLabel: string;
  problem: string; // grader's short label ("3 a-c")
  statement: string; // statement of record, $-LaTeX text
  solution: string; // internal reference checklist (shown only in the detail view)
  verdict: 'correct' | 'open';
  thumb: string; // small JPEG data URL for the list
  title: string; // index fields, filled by the background indexer
  description: string;
  topics: string[];
  keywords: string[];
  difficulty: number; // 0 = not indexed yet
  indexed: boolean;
}

export const archiveStore = reactive({
  items: [] as ArchivedAufgabe[],
  ready: false,
});

// Set by the Archive tab's "Practice again" button and Progress's "Pin on the pad";
// App switches to the pad and MainView pins the text, one gesture end to end.
export const practiceText = ref('');

const COL = 'archive';
const INDEX_MODEL = 'gpt-5.4-mini';
const MAX_AUTO_REINDEX = 8; // per session, so a broken corpus cannot burn tokens forever
const MIGRATED_KEY = 'nl.archive.migratedToDisk';

function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

// ---- one-time import of the previous IndexedDB store ----

function idbReq<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function migrateFromIdb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  if (localStorage.getItem(MIGRATED_KEY)) return;
  try {
    const db = await new Promise<IDBDatabase | null>((resolve) => {
      const req = indexedDB.open('nl.archive', 1);
      req.onupgradeneeded = () => {
        // The DB did not exist before this open: nothing to migrate.
        req.transaction?.abort();
        resolve(null);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    });
    if (!db) {
      localStorage.setItem(MIGRATED_KEY, '1');
      return;
    }
    const have = new Set(archiveStore.items.map((it) => it.id));
    if (db.objectStoreNames.contains('items')) {
      const items = await idbReq(
        db.transaction('items', 'readonly').objectStore('items').getAll(),
      ) as ArchivedAufgabe[];
      for (const it of items) {
        if (!it?.id || have.has(it.id)) continue;
        let image = '';
        if (db.objectStoreNames.contains('images')) {
          const rec = (await idbReq(
            db.transaction('images', 'readonly').objectStore('images').get(it.id),
          )) as { image?: string } | undefined;
          image = rec?.image ?? '';
        }
        await colPut(COL, it.id, plain(it));
        if (image) await blobPut(COL, it.id, image);
        archiveStore.items.push(it);
      }
      archiveStore.items.sort((a, b) => b.ts - a.ts);
    }
    db.close();
    localStorage.setItem(MIGRATED_KEY, '1');
    console.info('[nuclear-math] archive imported from IndexedDB to the file database.');
  } catch (err) {
    console.warn('[nuclear-math] archive IndexedDB import failed (will retry next boot):', err);
  }
}

async function init(): Promise<void> {
  if (!dbState.available) {
    console.warn('[nuclear-math] file database unavailable: the archive will not persist this session.');
    archiveStore.ready = true;
    return;
  }
  try {
    const items = await colList<ArchivedAufgabe>(COL);
    items.sort((a, b) => b.ts - a.ts);
    archiveStore.items = items;
    archiveStore.ready = true;
    await migrateFromIdb();
    // Self-healing: entries whose index call failed earlier get one more try per
    // session, newest first, bounded.
    const missing = archiveStore.items.filter((it) => !it.indexed).slice(0, MAX_AUTO_REINDEX);
    for (const it of missing) void indexAufgabe(it.id);
  } catch (err) {
    console.warn('[nuclear-math] archive unavailable:', err);
    archiveStore.ready = true;
  }
}

void init();

async function persistItem(rec: ArchivedAufgabe): Promise<void> {
  if (!dbState.available) return;
  await colPut(COL, rec.id, plain(rec));
}

export interface SaveAufgabeInput {
  modeId: string;
  modeLabel: string;
  problem: string;
  statement: string;
  solution: string;
  verdict: 'correct' | 'open';
  image: string; // full-size JPEG data URL (the exact image the grader saw)
  thumb: string;
}

/**
 * Save the current page. Re-saving the same problem (same normalized statement, or
 * same label when no statement exists) UPDATES the entry instead of duplicating it:
 * the manual Archive press mid-work followed by the automatic save on CORRECT is
 * one Aufgabe, ending in verdict 'correct' with the final image.
 */
export async function saveAufgabe(input: SaveAufgabeInput): Promise<ArchivedAufgabe> {
  const key = normText(input.statement || input.problem);
  const existing = key ? archiveStore.items.find((it) => normText(it.statement || it.problem) === key) : undefined;
  if (existing) {
    existing.ts = Date.now();
    existing.verdict = input.verdict === 'correct' ? 'correct' : existing.verdict;
    existing.solution = input.solution || existing.solution;
    existing.problem = input.problem || existing.problem;
    existing.thumb = input.thumb || existing.thumb;
    archiveStore.items.sort((a, b) => b.ts - a.ts);
    await persistItem(existing);
    if (dbState.available) await blobPut(COL, existing.id, input.image);
    if (!existing.indexed) void indexAufgabe(existing.id);
    return existing;
  }
  const rec: ArchivedAufgabe = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    ts: Date.now(),
    modeId: input.modeId,
    modeLabel: input.modeLabel,
    problem: input.problem,
    statement: input.statement,
    solution: input.solution.slice(0, 4000),
    verdict: input.verdict,
    thumb: input.thumb,
    title: '',
    description: '',
    topics: [],
    keywords: [],
    difficulty: 0,
    indexed: false,
  };
  archiveStore.items.unshift(rec);
  await persistItem(rec);
  if (dbState.available) await blobPut(COL, rec.id, input.image);
  void indexAufgabe(rec.id);
  return rec;
}

export async function removeAufgabe(id: string): Promise<void> {
  const i = archiveStore.items.findIndex((it) => it.id === id);
  if (i >= 0) archiveStore.items.splice(i, 1);
  try {
    if (dbState.available) await colDelete(COL, id);
  } catch (err) {
    console.warn('[nuclear-math] archive delete failed:', err);
  }
}

export async function loadImage(id: string): Promise<string> {
  try {
    if (!dbState.available) return '';
    return await blobGet(COL, id);
  } catch {
    return '';
  }
}

// ---- the background indexer ----

const INDEX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'description', 'topics', 'keywords', 'difficulty'],
  properties: {
    title: { type: 'string' },
    description: { type: 'string' },
    topics: { type: 'array', items: { type: 'string' } },
    keywords: { type: 'array', items: { type: 'string' } },
    difficulty: { type: 'integer', enum: [1, 2, 3, 4, 5, 6, 7] },
  },
};

const INDEX_SYSTEM = `You label one archived mathematics problem for a personal search index. The learner will later find it by typing a few words into a search box, so write what a searcher would type. Return JSON:
- "title": ONE short German line naming the task type and its object ("Bruchgleichung mit Parameter nach x auflösen"), max ~60 characters, plain words (LaTeX only when a symbol is the point).
- "description": one or two German sentences: what is given, what is asked, and the method that solves it. Mathematics in $-LaTeX between single $ delimiters.
- "topics": 1 to 4 German curriculum tags from coarse to fine ("Algebra", "Potenzgesetze"), short noun phrases, no duplicates.
- "keywords": 6 to 12 lowercase search terms a learner might type — German first, common English or school synonyms after ("potenzen", "wurzel", "exponent", "simplify"); single words or two-word phrases; do not repeat the topics verbatim.
- "difficulty": 1-7 on the Swiss ladder (1-2 Sek/early BM routine, 3 BM/FH core, 4 Passerelle entrance, 5+ university).`;

function decodeImage(imageDataUrl: string): { data: string; mediaType: string } {
  const match = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(imageDataUrl);
  return {
    mediaType: match?.[1] ?? 'image/jpeg',
    data: match?.[2] ?? imageDataUrl.replace(/^data:[^,]*,/, ''),
  };
}

/**
 * One cheap text-only call fills the search fields; the image rides along only when
 * the entry has no statement text at all (an unlabeled manual save). Background
 * lane: an index write must never delay a scan the learner is waiting on.
 */
export async function indexAufgabe(id: string): Promise<boolean> {
  const rec = archiveStore.items.find((it) => it.id === id);
  if (!rec) return false;
  try {
    const lines = [
      rec.problem ? `Problem label: ${rec.problem}` : '',
      rec.statement ? `Problem statement: ${rec.statement}` : '',
      rec.solution ? `Reference solution (internal):\n${rec.solution.slice(0, 1200)}` : '',
      'Write the index entry.',
    ].filter(Boolean);
    const content: unknown[] = [{ type: 'text', text: lines.join('\n') }];
    if (!rec.statement && !rec.problem) {
      const image = await loadImage(id);
      if (image) {
        const { data, mediaType } = decodeImage(image);
        content.push({ type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } });
      }
    }
    const resp = await createCompletion(
      {
        model: INDEX_MODEL,
        max_completion_tokens: 3000,
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: INDEX_SYSTEM },
          { role: 'user', content },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'archive_index', strict: true, schema: INDEX_SCHEMA },
        },
      },
      { timeout: 60000, lane: 'background' },
    );
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: rec.modeId,
      model: INDEX_MODEL,
      role: 'index',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreate: 0,
    });
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    const parsed = JSON.parse(out) as {
      title?: string;
      description?: string;
      topics?: unknown;
      keywords?: unknown;
      difficulty?: number;
    };
    const title = cleanText(parsed.title).trim();
    if (!title) return false;
    rec.title = title;
    rec.description = cleanText(parsed.description).trim();
    rec.topics = Array.isArray(parsed.topics)
      ? parsed.topics.filter((t): t is string => typeof t === 'string').map((t) => cleanText(t).trim()).filter(Boolean).slice(0, 4)
      : [];
    rec.keywords = Array.isArray(parsed.keywords)
      ? parsed.keywords.filter((k): k is string => typeof k === 'string').map((k) => cleanText(k).trim().toLowerCase()).filter(Boolean).slice(0, 12)
      : [];
    rec.difficulty = typeof parsed.difficulty === 'number' ? Math.min(7, Math.max(1, Math.trunc(parsed.difficulty))) : 0;
    rec.indexed = true;
    await persistItem(rec);
    return true;
  } catch (err) {
    console.warn('[nuclear-math] archive indexing failed:', err);
    return false;
  }
}

// ---- search ----

/**
 * Token-AND search over the index fields, weighted so the LLM-written labels rank
 * above raw statement text. Umlauts and ß are folded on both sides, so "loesen",
 * "lösen", and "losen" all find the same entry. Empty query = the full archive,
 * newest first; `topic` narrows to one tag (the chip row).
 */
export function searchArchive(q: string, topic?: string): ArchivedAufgabe[] {
  let pool = archiveStore.items;
  if (topic) {
    const t = normText(topic);
    pool = pool.filter((it) => it.topics.some((x) => normText(x) === t));
  }
  const tokens = normText(q).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [...pool].sort((a, b) => b.ts - a.ts);
  const scored: { it: ArchivedAufgabe; score: number }[] = [];
  for (const it of pool) {
    const fields: [string, number][] = [
      [normText(it.title), 4],
      [normText(it.topics.join(' ')), 3],
      [normText(it.keywords.join(' ')), 3],
      [normText(it.problem), 2],
      [normText(it.description), 2],
      [normText(it.statement), 1],
    ];
    let score = 0;
    let allHit = true;
    for (const tok of tokens) {
      let hit = 0;
      for (const [text, weight] of fields) {
        if (text && text.includes(tok)) hit = Math.max(hit, weight);
      }
      if (hit === 0) {
        allHit = false;
        break;
      }
      score += hit;
    }
    if (allHit) scored.push({ it, score });
  }
  scored.sort((a, b) => b.score - a.score || b.it.ts - a.it.ts);
  return scored.map((s) => s.it);
}

/** All topics in the archive with counts, for the filter chip row. */
export function topicCounts(): { topic: string; count: number }[] {
  const counts = new Map<string, { topic: string; count: number }>();
  for (const it of archiveStore.items) {
    for (const t of it.topics) {
      const key = normText(t);
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { topic: t, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count);
}

/** Downscale a data-URL image to a thumbnail JPEG (list rendering stays light). */
export function makeThumb(dataUrl: string, maxEdge = 320): Promise<string> {
  return new Promise((resolve) => {
    if (!dataUrl) {
      resolve('');
      return;
    }
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, maxEdge / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * k));
      c.height = Math.max(1, Math.round(img.height * k));
      const ctx = c.getContext('2d');
      if (!ctx) {
        resolve('');
        return;
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, c.width, c.height);
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.72));
    };
    img.onerror = () => resolve('');
    img.src = dataUrl;
  });
}

// Console probe: __nlArchive() lists what is stored and which entries still wait for
// their index write, so a silent indexing failure is visible without the network tab.
if (typeof window !== 'undefined') {
  (window as unknown as { __nlArchive: unknown }).__nlArchive = () => ({
    ready: archiveStore.ready,
    disk: dbState.available,
    count: archiveStore.items.length,
    unindexed: archiveStore.items.filter((it) => !it.indexed).map((it) => it.id),
    items: archiveStore.items.map((it) => ({ id: it.id, title: it.title || it.problem, ts: it.ts })),
  });
}
