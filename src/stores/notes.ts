import { reactive } from 'vue';
import { cleanText, createCompletion } from '@/api';
import { recordUsage } from '@/stores/usage';
import { blobGet, blobPut, colDelete, colList, colPut, dbState } from '@/db';

/**
 * Notes: a personal notebook beside the math loop, on the conventions real note
 * apps converge on — quick capture into an Inbox (organize later), folders as the
 * one home of a note (nested subfolders), a small set of tags for cross-cutting
 * themes, full-text search, pinning, and editable titles.
 *
 * A note can be anything, math or not. Handwritten pad captures carry their image,
 * and one background vision call transcribes each into TEXT (title, transcript,
 * tags, language). The transcript is the point: the ask request attaches notes as
 * compact text, so referring to a folder of notes costs a few hundred tokens
 * instead of a hundred screenshots.
 *
 * Storage is the dev server's file database (data/notes/*, data/notefolders/*):
 * real files, safe from browser-data wipes.
 *
 * Console access: __nlNotes()
 */

export interface NoteFolder {
  id: string;
  name: string;
  parentId: string | null; // null = root
}

export interface Note {
  id: string;
  ts: number; // created
  edited: number;
  folderId: string;
  title: string;
  text: string; // the transcript / typed body — machine-seeded, what ask requests attach
  // The student's OWN field, never touched by extraction: assignment background,
  // where the note comes from, what it is for. Dumped freely, and it rides into
  // every chat/ask the note is attached to — the "why" beside the transcript's "what".
  context: string;
  tags: string[];
  pinned: boolean;
  source: 'pad' | 'typed';
  thumb: string; // data URL preview for pad notes ('' for typed)
  hasImage: boolean;
  // Strokes stored beside the image (<id>-ink blob): the note can be reopened in
  // the editor and continued, instead of being a dead snapshot.
  hasInk?: boolean;
  // A pre-strokes note that was continued keeps its ORIGINAL image as a permanent
  // backdrop layer (<id>-bg blob) under the new strokes, so nothing old is lost on
  // later edits.
  hasBg?: boolean;
  extracted: boolean; // transcript ready (typed notes are born extracted)
  lang?: string;
}

export const INBOX_ID = 'inbox';
const NOTES_COL = 'notes';
const FOLDERS_COL = 'notefolders';
const EXTRACT_MODEL = 'gpt-5.4-mini';
const MAX_AUTO_EXTRACT = 8; // failed extractions retried per session, bounded

export const notesStore = reactive({
  folders: [] as NoteFolder[],
  notes: [] as Note[],
  ready: false,
});

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function normText(s: string): string {
  return s
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function persistFolder(f: NoteFolder): Promise<void> {
  if (dbState.available) await colPut(FOLDERS_COL, f.id, plain(f));
}

async function persistNote(n: Note): Promise<void> {
  if (dbState.available) await colPut(NOTES_COL, n.id, plain(n));
}

async function init(): Promise<void> {
  if (dbState.available) {
    try {
      const [folders, notes] = await Promise.all([
        colList<NoteFolder>(FOLDERS_COL),
        colList<Note>(NOTES_COL),
      ]);
      notesStore.folders = folders;
      // Notes saved before the context field existed normalize to an empty one.
      for (const n of notes) {
        if (typeof n.context !== 'string') n.context = '';
      }
      notesStore.notes = notes.sort((a, b) => b.ts - a.ts);
    } catch (err) {
      console.warn('[nuclear-math] notes load failed:', err);
    }
  } else {
    console.warn('[nuclear-math] file database unavailable: notes will not persist this session.');
  }
  // The Inbox always exists: quick capture must never ask where to file first.
  if (!notesStore.folders.some((f) => f.id === INBOX_ID)) {
    const inbox: NoteFolder = { id: INBOX_ID, name: 'Inbox', parentId: null };
    notesStore.folders.push(inbox);
    void persistFolder(inbox);
  }
  notesStore.ready = true;
  const pending = notesStore.notes
    .filter((n) => n.hasImage && !n.extracted)
    .slice(0, MAX_AUTO_EXTRACT);
  for (const n of pending) void extractNote(n.id);
}

void init();

// ---- folders ----

export function folderById(id: string): NoteFolder | undefined {
  return notesStore.folders.find((f) => f.id === id);
}

/** "Mathe / Analysis / Grenzwerte" — the display path of a folder. */
export function folderPath(id: string): string {
  const parts: string[] = [];
  let cur = folderById(id);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? folderById(cur.parentId) : undefined;
  }
  return parts.join(' / ');
}

/** DFS over the folder tree (Inbox first at root), with depth for indentation. */
export function folderTree(): { folder: NoteFolder; depth: number }[] {
  const byParent = new Map<string | null, NoteFolder[]>();
  for (const f of notesStore.folders) {
    const key = f.parentId ?? null;
    const list = byParent.get(key) ?? [];
    list.push(f);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) {
    list.sort((a, b) =>
      a.id === INBOX_ID ? -1 : b.id === INBOX_ID ? 1 : a.name.localeCompare(b.name, 'de'),
    );
  }
  const out: { folder: NoteFolder; depth: number }[] = [];
  const walk = (parentId: string | null, depth: number, guard: Set<string>) => {
    for (const f of byParent.get(parentId) ?? []) {
      if (guard.has(f.id)) continue; // a cycle from hand-edited files must not hang the UI
      guard.add(f.id);
      out.push({ folder: f, depth });
      walk(f.id, depth + 1, guard);
    }
  };
  walk(null, 0, new Set());
  return out;
}

/** A folder plus every descendant, for subtree note listings and ask references. */
export function subtreeIds(folderId: string): Set<string> {
  const ids = new Set<string>([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of notesStore.folders) {
      if (f.parentId && ids.has(f.parentId) && !ids.has(f.id)) {
        ids.add(f.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function addFolder(name: string, parentId: string | null): NoteFolder {
  const f: NoteFolder = { id: newId(), name: name.trim() || 'Folder', parentId };
  notesStore.folders.push(f);
  void persistFolder(f);
  return f;
}

export function renameFolder(id: string, name: string): void {
  const f = folderById(id);
  if (!f || id === INBOX_ID || !name.trim()) return;
  f.name = name.trim();
  void persistFolder(f);
}

/**
 * Delete a folder, never its contents: child folders are re-parented one level up
 * and the folder's notes move there too (or to the Inbox at root). Losing a note to
 * a folder delete would break the "trust it later" contract.
 */
export function deleteFolder(id: string): void {
  const f = folderById(id);
  if (!f || id === INBOX_ID) return;
  const target = f.parentId ?? INBOX_ID;
  for (const child of notesStore.folders) {
    if (child.parentId === id) {
      child.parentId = f.parentId;
      void persistFolder(child);
    }
  }
  for (const n of notesStore.notes) {
    if (n.folderId === id) {
      n.folderId = target;
      void persistNote(n);
    }
  }
  notesStore.folders = notesStore.folders.filter((x) => x.id !== id);
  if (dbState.available) void colDelete(FOLDERS_COL, id);
}

// ---- notes ----

export function notesInFolder(folderId: string, subtree = false): Note[] {
  const ids = subtree ? subtreeIds(folderId) : new Set([folderId]);
  return notesStore.notes
    .filter((n) => ids.has(n.folderId))
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.ts - a.ts);
}

export async function saveNoteFromPad(
  input: { image: string; thumb: string; strokes?: unknown[] },
  folderId: string = INBOX_ID,
): Promise<Note> {
  const n: Note = {
    id: newId(),
    ts: Date.now(),
    edited: Date.now(),
    folderId: folderById(folderId) ? folderId : INBOX_ID,
    title: '',
    text: '',
    context: '',
    tags: [],
    pinned: false,
    source: 'pad',
    thumb: input.thumb,
    hasImage: true,
    hasInk: Boolean(input.strokes?.length),
    extracted: false,
  };
  notesStore.notes.unshift(n);
  await persistNote(n);
  if (dbState.available) {
    await blobPut(NOTES_COL, n.id, input.image);
    if (input.strokes?.length) await blobPut(NOTES_COL, `${n.id}-ink`, JSON.stringify(input.strokes));
  }
  void extractNote(n.id);
  return n;
}

/**
 * Re-save an ink note after continuing it in the editor: fresh image, thumb, and
 * strokes; the transcript re-extracts (the ink is its source of truth) while the
 * title, tags, and the user's context stay.
 */
export async function updateNoteInk(
  id: string,
  input: { image: string; thumb: string; strokes: unknown[]; bg?: string },
): Promise<void> {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n) return;
  n.thumb = input.thumb;
  n.hasImage = true;
  n.hasInk = input.strokes.length > 0;
  if (input.bg) n.hasBg = true;
  n.text = '';
  n.extracted = false;
  n.edited = Date.now();
  await persistNote(n);
  if (dbState.available) {
    if (input.bg) await blobPut(NOTES_COL, `${id}-bg`, input.bg);
    await blobPut(NOTES_COL, id, input.image);
    await blobPut(NOTES_COL, `${id}-ink`, JSON.stringify(input.strokes));
  }
  void extractNote(id);
}

export async function loadNoteBg(id: string): Promise<string> {
  try {
    if (!dbState.available) return '';
    return await blobGet(NOTES_COL, `${id}-bg`);
  } catch {
    return '';
  }
}

export async function loadNoteInk(id: string): Promise<unknown[] | null> {
  try {
    if (!dbState.available) return null;
    const raw = await blobGet(NOTES_COL, `${id}-ink`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function addTypedNote(folderId: string): Note {
  const n: Note = {
    id: newId(),
    ts: Date.now(),
    edited: Date.now(),
    folderId: folderById(folderId) ? folderId : INBOX_ID,
    title: '',
    text: '',
    context: '',
    tags: [],
    pinned: false,
    source: 'typed',
    thumb: '',
    hasImage: false,
    extracted: true,
  };
  notesStore.notes.unshift(n);
  void persistNote(n);
  return n;
}

export function updateNote(
  id: string,
  patch: Partial<Pick<Note, 'title' | 'text' | 'context' | 'tags' | 'folderId' | 'pinned'>>,
): void {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n) return;
  if (patch.title !== undefined) n.title = patch.title;
  if (patch.text !== undefined) n.text = patch.text;
  if (patch.context !== undefined) n.context = patch.context;
  if (patch.tags !== undefined) n.tags = patch.tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
  if (patch.folderId !== undefined && folderById(patch.folderId)) n.folderId = patch.folderId;
  if (patch.pinned !== undefined) n.pinned = patch.pinned;
  n.edited = Date.now();
  void persistNote(n);
}

export async function deleteNote(id: string): Promise<void> {
  notesStore.notes = notesStore.notes.filter((n) => n.id !== id);
  if (dbState.available) {
    try {
      await colDelete(NOTES_COL, id);
      await colDelete(NOTES_COL, `${id}-ink`); // removes the strokes blob (no JSON exists)
      await colDelete(NOTES_COL, `${id}-bg`);
    } catch (err) {
      console.warn('[nuclear-math] note delete failed:', err);
    }
  }
}

export async function loadNoteImage(id: string): Promise<string> {
  try {
    if (!dbState.available) return '';
    return await blobGet(NOTES_COL, id);
  } catch {
    return '';
  }
}

// ---- the transcription pipeline (the "wrapper" that turns ink into ask-ready text) ----

const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'transcript', 'tags', 'language'],
  properties: {
    title: { type: 'string' },
    transcript: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    language: { type: 'string' },
  },
};

const EXTRACT_SYSTEM = `You transcribe ONE handwritten note into a personal knowledge base. The note may be about anything — mathematics, code, ideas, plans, lists — and stays in its own language. Return JSON:
- "transcript": the faithful transcription. Preserve the note's structure (line breaks, bullets, numbering, headings); write every mathematical expression in $-LaTeX between single $ delimiters; mark genuinely unreadable spots as [?]. Never summarize, never translate, never add content that is not written.
- "title": ONE short line (max 60 characters) naming what the note is, in the note's own language.
- "tags": 3 to 8 lowercase tags a searcher would type, in the note's language plus obvious English equivalents, no duplicates.
- "language": the note's main language as a two-letter code ("de", "en").`;

function decodeImage(imageDataUrl: string): { data: string; mediaType: string } {
  const match = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(imageDataUrl);
  return {
    mediaType: match?.[1] ?? 'image/jpeg',
    data: match?.[2] ?? imageDataUrl.replace(/^data:[^,]*,/, ''),
  };
}

/** One background vision call per note; the learner's own edits always win over a re-run. */
export async function extractNote(id: string): Promise<boolean> {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n || !n.hasImage) return false;
  try {
    const image = await loadNoteImage(id);
    if (!image) return false;
    const { data, mediaType } = decodeImage(image);
    const resp = await createCompletion(
      {
        model: EXTRACT_MODEL,
        max_completion_tokens: 6000,
        reasoning_effort: 'low',
        messages: [
          { role: 'system', content: EXTRACT_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Transcribe this note.' },
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } },
            ],
          },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'note_extract', strict: true, schema: EXTRACT_SCHEMA },
        },
      },
      { timeout: 60000, lane: 'background' },
    );
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: 'notes',
      model: EXTRACT_MODEL,
      role: 'note',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreate: 0,
    });
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    const parsed = JSON.parse(out) as {
      title?: string;
      transcript?: string;
      tags?: unknown;
      language?: string;
    };
    const transcript = cleanText(parsed.transcript).trim();
    if (!transcript) return false;
    // Hand-edited fields survive a re-extract; only the untouched ones fill in.
    if (!n.title) n.title = cleanText(parsed.title).trim().slice(0, 80);
    if (!n.text) n.text = transcript;
    if (!n.tags.length && Array.isArray(parsed.tags)) {
      n.tags = parsed.tags
        .filter((t): t is string => typeof t === 'string')
        .map((t) => cleanText(t).trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8);
    }
    n.lang = typeof parsed.language === 'string' ? parsed.language.slice(0, 5) : n.lang;
    n.extracted = true;
    n.edited = Date.now();
    await persistNote(n);
    return true;
  } catch (err) {
    console.warn('[nuclear-math] note transcription failed:', err);
    return false;
  }
}

/** Force a fresh transcription: clears the machine-filled fields first, keeps the pin/folder. */
export async function reExtractNote(id: string): Promise<boolean> {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n || !n.hasImage) return false;
  n.title = '';
  n.text = '';
  n.tags = [];
  n.extracted = false;
  await persistNote(n);
  return extractNote(id);
}

// ---- search ----

export function searchNotes(q: string, folderId?: string): Note[] {
  const pool = folderId ? notesInFolder(folderId, true) : [...notesStore.notes];
  const tokens = normText(q).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return pool.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.ts - a.ts);
  }
  const scored: { n: Note; score: number }[] = [];
  for (const n of pool) {
    const fields: [string, number][] = [
      [normText(n.title), 4],
      [normText(n.tags.join(' ')), 3],
      [normText(n.text), 2],
      [normText(n.context), 2],
      [normText(folderPath(n.folderId)), 1],
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
    if (allHit) scored.push({ n, score });
  }
  scored.sort((a, b) => b.score - a.score || b.n.ts - a.n.ts);
  return scored.map((s) => s.n);
}

// ---- the ask attachment resolver ----

export interface AskNote {
  title: string;
  path: string;
  text: string;
  context: string; // the student's own context dump, '' when none
}

/**
 * Resolve an ask selection (individual notes + whole folders, subtrees included)
 * into compact text blocks, pinned-then-newest, deduped, capped: the wrapper that
 * lets an ask request carry a folder of handwriting as a few hundred tokens of
 * text. Notes whose transcript is still in flight are reported, not silently lost.
 */
export function resolveAskNotes(
  noteIds: string[],
  folderIds: string[],
  capChars = 9000,
): { notes: AskNote[]; omitted: number; pending: number } {
  const wanted = new Map<string, Note>();
  for (const id of noteIds) {
    const n = notesStore.notes.find((x) => x.id === id);
    if (n) wanted.set(n.id, n);
  }
  for (const fid of folderIds) {
    for (const n of notesInFolder(fid, true)) wanted.set(n.id, n);
  }
  const ordered = [...wanted.values()].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || b.ts - a.ts,
  );
  const notes: AskNote[] = [];
  let used = 0;
  let omitted = 0;
  let pending = 0;
  for (const n of ordered) {
    // A note with only a context dump (transcript still pending, or none) still
    // attaches: the student's own framing is context enough to talk about it.
    if (!n.text.trim() && !n.context.trim()) {
      pending += 1;
      continue;
    }
    const text = n.text.length > 3000 ? `${n.text.slice(0, 3000)}\n[…]` : n.text;
    const context = n.context.length > 1500 ? `${n.context.slice(0, 1500)}\n[…]` : n.context.trim();
    const cost = text.length + context.length + n.title.length + 60;
    if (used + cost > capChars) {
      omitted += 1;
      continue;
    }
    used += cost;
    notes.push({ title: n.title || 'Untitled', path: folderPath(n.folderId), text, context });
  }
  return { notes, omitted, pending };
}

// Console probe: __nlNotes() shows the tree, counts, and which transcripts are
// still pending — extraction problems become visible facts.
if (typeof window !== 'undefined') {
  (window as unknown as { __nlNotes: unknown }).__nlNotes = () => ({
    ready: notesStore.ready,
    disk: dbState.available,
    folders: notesStore.folders.map((f) => ({ id: f.id, path: folderPath(f.id) })),
    notes: notesStore.notes.length,
    pending: notesStore.notes.filter((n) => n.hasImage && !n.extracted).map((n) => n.id),
  });
}
