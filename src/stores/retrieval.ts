import { createEmbeddings } from '@/api';
import { blobGet, blobPut, colDelete, dbState } from '@/db';
import { settings } from '@/stores/settings';
import { recordUsage } from '@/stores/usage';
import { folderPath, notesInFolder, notesStore, type Note } from '@/stores/notes';

/**
 * Retrieval over the notebook, so a chat can be grounded in a whole module rather
 * than in whatever fitted under a character cap.
 *
 * The old path attached transcripts verbatim and stopped at 9000 characters, which
 * meant that attaching a folder of a term's notes quietly sent a few of them and
 * counted the rest as "omitted". This is the shape NotebookLM uses instead: every
 * note is cut into overlapping passages once, each passage is embedded once, and a
 * question retrieves only the passages that actually bear on it. What reaches the
 * model is small and relevant no matter how large the folder is, and every passage
 * still carries the note it came from so the answer can cite it.
 *
 * The index lives on disk beside the notes (data/vectors/<noteId>.json) and is
 * rebuilt for a note only when that note's text changes, which is what the stored
 * hash is for. Nothing here runs on the scan lane, so indexing never delays the pen.
 *
 * Console access: __nlVectors()
 */

const COL = 'vectors';

// Passages are big enough to carry an argument and small enough that a handful of
// them still leaves room for the conversation. The overlap keeps a definition that
// straddles a boundary readable in at least one of the two passages.
const CHUNK_CHARS = 900;
const CHUNK_OVERLAP = 150;
const MAX_CHUNKS_PER_NOTE = 60; // a filed thesis must not become a thousand vectors
const EMBED_BATCH = 64;

export const embedModel = (): string => settings.api.embedModel || 'text-embedding-3-small';

export interface VecChunk {
  i: number;
  text: string;
  vec: number[];
}

export interface VecRecord {
  id: string; // note id
  hash: string; // of the exact text that was indexed
  model: string;
  chunks: VecChunk[];
}

export interface Passage {
  noteId: string;
  title: string;
  path: string;
  text: string;
  score: number;
}

export const retrievalState = {
  indexing: 0, // notes currently being embedded
  lastError: '',
};

/** Cheap, stable, and enough to notice any edit. Not a security hash. */
function hashOf(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 + c, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return `${(h1 >>> 0).toString(36)}${(h2 >>> 0).toString(36)}-${s.length}`;
}

/**
 * What of a note gets indexed. The student's own context goes in with the
 * transcript, because it is often the half that says what the page is for, and a
 * question about "the assignment" should be able to find it.
 */
function indexableText(n: Note): string {
  const parts: string[] = [];
  if (n.title.trim()) parts.push(n.title.trim());
  if (n.context.trim()) parts.push(n.context.trim());
  if (n.text.trim()) parts.push(n.text.trim());
  return parts.join('\n\n');
}

/** Cut on paragraph boundaries where possible, hard-cut only when a block is huge. */
export function chunkText(s: string): string[] {
  const clean = s.replace(/\r/g, '').trim();
  if (!clean) return [];
  if (clean.length <= CHUNK_CHARS) return [clean];
  const out: string[] = [];
  const paras = clean.split(/\n{2,}/);
  let buf = '';
  const flush = () => {
    if (buf.trim()) out.push(buf.trim());
    buf = '';
  };
  for (const p of paras) {
    if (p.length > CHUNK_CHARS) {
      flush();
      for (let i = 0; i < p.length; i += CHUNK_CHARS - CHUNK_OVERLAP) {
        out.push(p.slice(i, i + CHUNK_CHARS));
        if (out.length >= MAX_CHUNKS_PER_NOTE) return out.slice(0, MAX_CHUNKS_PER_NOTE);
      }
      continue;
    }
    if (buf.length + p.length + 2 > CHUNK_CHARS) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
    if (out.length >= MAX_CHUNKS_PER_NOTE) break;
  }
  flush();
  return out.slice(0, MAX_CHUNKS_PER_NOTE);
}

function norm(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const len = Math.sqrt(sum) || 1;
  return v.map((x) => x / len);
}

function dot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i += 1) s += a[i] * b[i];
  return s;
}

/** Four decimals is well inside the noise of a similarity ranking and a third the bytes. */
function pack(v: number[]): number[] {
  return norm(v).map((x) => Number(x.toFixed(4)));
}

async function embed(texts: string[], lane: 'scan' | 'background'): Promise<number[][]> {
  const out: number[][] = [];
  const model = embedModel();
  for (let i = 0; i < texts.length; i += EMBED_BATCH) {
    const batch = texts.slice(i, i + EMBED_BATCH);
    const resp = await createEmbeddings({ model, input: batch }, { lane, timeout: 60000 });
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: 'notes',
      model,
      role: 'note',
      input: u.prompt_tokens ?? u.total_tokens ?? 0,
      output: 0,
      cacheRead: 0,
      cacheCreate: 0,
    });
    for (const d of (resp as any)?.data ?? []) out.push(d.embedding as number[]);
  }
  return out;
}

// One file per note, fetched by id. colList would pull the whole index into memory
// to answer a question about one note.
async function loadRecord(id: string): Promise<VecRecord | null> {
  if (!dbState.available) return null;
  try {
    const raw = await blobGet(COL, id);
    if (!raw) return null;
    const rec = JSON.parse(raw) as VecRecord;
    return Array.isArray(rec?.chunks) ? rec : null;
  } catch {
    return null;
  }
}

/**
 * Bring one note's index up to date. Returns false when there is nothing to index
 * or the embedding call failed; the caller falls back to sending text verbatim.
 */
export async function indexNote(id: string, lane: 'scan' | 'background' = 'background'): Promise<boolean> {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n || !dbState.available) return false;
  const text = indexableText(n);
  if (!text.trim()) return false;
  const hash = hashOf(text);
  const model = embedModel();
  const have = await loadRecord(id);
  if (have && have.hash === hash && have.model === model && have.chunks.length) return true;

  const pieces = chunkText(text);
  if (!pieces.length) return false;
  retrievalState.indexing += 1;
  try {
    const vecs = await embed(pieces, lane);
    if (vecs.length !== pieces.length) return false;
    const rec: VecRecord = {
      id,
      hash,
      model,
      chunks: pieces.map((t, i) => ({ i, text: t, vec: pack(vecs[i]) })),
    };
    await blobPut(COL, id, JSON.stringify(rec));
    retrievalState.lastError = '';
    return true;
  } catch (err) {
    retrievalState.lastError = err instanceof Error ? err.message : String(err);
    console.warn('[nuclear-learning] indexing a note failed:', err);
    return false;
  } finally {
    retrievalState.indexing -= 1;
  }
}

export async function dropIndex(id: string): Promise<void> {
  if (!dbState.available) return;
  try {
    await colDelete(COL, id);
  } catch {
    /* an index that will not delete is stale, not fatal */
  }
}

/** Every note an attachment selection resolves to, notes and whole folder subtrees. */
export function selectedNotes(noteIds: string[], folderIds: string[]): Note[] {
  const wanted = new Map<string, Note>();
  for (const id of noteIds) {
    const n = notesStore.notes.find((x) => x.id === id);
    if (n) wanted.set(n.id, n);
  }
  for (const fid of folderIds) for (const n of notesInFolder(fid, true)) wanted.set(n.id, n);
  return [...wanted.values()];
}

/**
 * Index everything in a selection that is out of date. Runs on the background lane
 * and one request at a time, so a big folder indexes steadily behind whatever else
 * the app is doing rather than in a burst.
 */
export async function ensureIndexed(noteIds: string[], folderIds: string[]): Promise<void> {
  for (const n of selectedNotes(noteIds, folderIds)) {
    if (!indexableText(n).trim()) continue;
    await indexNote(n.id);
  }
}

/**
 * The passages worth showing the model for one question. Notes with no usable index
 * are reported back so the caller can fall back to sending their text verbatim
 * instead of silently answering without them.
 */
export async function retrieve(
  question: string,
  noteIds: string[],
  folderIds: string[],
  topK = 14,
): Promise<{ passages: Passage[]; unindexed: Note[]; searched: number }> {
  const notes = selectedNotes(noteIds, folderIds);
  const unindexed: Note[] = [];
  if (!notes.length) return { passages: [], unindexed, searched: 0 };

  const records: { note: Note; rec: VecRecord }[] = [];
  const model = embedModel();
  for (const n of notes) {
    const rec = await loadRecord(n.id);
    if (rec?.chunks.length && rec.model === model && rec.hash === hashOf(indexableText(n))) {
      records.push({ note: n, rec });
    } else if (indexableText(n).trim()) {
      unindexed.push(n);
    }
  }
  if (!records.length) return { passages: [], unindexed, searched: 0 };

  // The question rides the scan lane: somebody is waiting on this one.
  let qvec: number[];
  try {
    const [v] = await embed([question], 'scan');
    if (!v) return { passages: [], unindexed, searched: 0 };
    qvec = norm(v);
  } catch (err) {
    console.warn('[nuclear-learning] embedding the question failed:', err);
    return { passages: [], unindexed: notes, searched: 0 };
  }

  const scored: Passage[] = [];
  let searched = 0;
  for (const { note, rec } of records) {
    for (const ch of rec.chunks) {
      searched += 1;
      scored.push({
        noteId: note.id,
        title: note.title || 'Untitled',
        path: folderPath(note.folderId),
        text: ch.text,
        score: dot(qvec, ch.vec),
      });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  // Spread the budget over sources: three passages from one note and none from the
  // others answers narrowly, and the point of attaching a folder is breadth.
  const perNote = new Map<string, number>();
  const picked: Passage[] = [];
  for (const p of scored) {
    if (picked.length >= topK) break;
    const used = perNote.get(p.noteId) ?? 0;
    if (used >= 4) continue;
    perNote.set(p.noteId, used + 1);
    picked.push(p);
  }
  return { passages: picked, unindexed, searched };
}

if (typeof window !== 'undefined') {
  (window as unknown as { __nlVectors: unknown }).__nlVectors = async () => {
    const rows = await Promise.all(
      notesStore.notes.map(async (n) => {
        const rec = await loadRecord(n.id);
        const fresh = rec ? rec.hash === hashOf(indexableText(n)) && rec.model === embedModel() : false;
        return {
          id: n.id,
          title: n.title || 'Untitled',
          chunks: rec?.chunks.length ?? 0,
          fresh,
        };
      }),
    );
    return {
      model: embedModel(),
      indexing: retrievalState.indexing,
      lastError: retrievalState.lastError,
      indexed: rows.filter((r) => r.chunks > 0).length,
      stale: rows.filter((r) => r.chunks > 0 && !r.fresh).length,
      notes: rows,
    };
  };
}
