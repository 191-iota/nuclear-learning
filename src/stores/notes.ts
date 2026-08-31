import { reactive } from 'vue';
import { cleanText, createCompletion } from '@/api';
import { modelInfo } from '@/models';
import { recordUsage } from '@/stores/usage';
import { blobGet, blobPut, colDelete, colList, colPut, dbState } from '@/db';
import { settings } from '@/stores/settings';
import { makeThumb } from '@/stores/archive';
import {
  exportInkTiles,
  imageBox,
  inReadingOrder,
  type TabletImage,
  type TabletStroke,
} from '@/composables/inkExport';

/**
 * Notes: a personal notebook beside the math loop, on the conventions real note
 * apps converge on — quick capture into an Inbox (organize later), folders as the
 * one home of a note (nested subfolders), a small set of tags for cross-cutting
 * themes, full-text search, pinning, and editable titles.
 *
 * A note can also be a document you already have: Word files, PDFs and text files
 * are dropped into a folder and kept beside the handwritten ones (see saveFileNote).
 *
 * A note can be anything, math or not. Handwritten pad captures carry their image,
 * and one background vision call transcribes each into TEXT (transcript, tags,
 * language; never the title, which stays the student's). The transcript is the
 * point: the ask request attaches notes as compact text, so referring to a folder
 * of notes costs a few hundred tokens instead of a hundred screenshots.
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
  /**
   * The folder's OWN background, written by the student and never by a model: what
   * the module is, how it is examined, what past papers looked like, what the
   * lecturer keeps asking. It rides into every chat that draws on anything filed
   * here, and it is inherited down the tree, so a subfolder answers with its
   * parent's framing as well as its own. A note's context says what that page is;
   * a folder's context says what the subject is.
   */
  context?: string;
}

export interface NoteFile {
  name: string;
  mime: string;
  size: number; // the original file's bytes, not the base64 the blob holds
}

export interface Note {
  id: string;
  ts: number; // created
  edited: number;
  folderId: string;
  // Named by hand or not at all: transcription never writes here, so a note keeps
  // the name it was given even when its transcript arrives long afterwards.
  title: string;
  /**
   * A title the transcriber offered, parked here and never applied. Reading the page
   * is the expensive half of naming it, and that already happened, so the offer is
   * kept from that one call and the button in the note dialog spends nothing to take
   * it. The student's title stays the student's: nothing but that button ever moves
   * this into `title`.
   */
  titleHint?: string;
  text: string; // the transcript / typed body — machine-seeded, what ask requests attach
  // The student's OWN field, never touched by extraction: assignment background,
  // where the note comes from, what it is for. Dumped freely, and it rides into
  // every chat/ask the note is attached to — the "why" beside the transcript's "what".
  context: string;
  tags: string[];
  pinned: boolean;
  source: 'pad' | 'typed' | 'file';
  thumb: string; // data URL preview for pad notes ('' for typed)
  hasImage: boolean;
  // A document filed into the notebook (Word, PDF, text, anything): the bytes live
  // in the note's blob exactly like a pad image, and these three fields say what
  // they are. Absent on notes that were written rather than filed.
  file?: NoteFile;
  // Strokes stored beside the image (<id>-ink blob): the note can be reopened in
  // the editor and continued, instead of being a dead snapshot.
  hasInk?: boolean;
  // A pre-strokes note that was continued keeps its ORIGINAL image as a permanent
  // backdrop layer (<id>-bg blob) under the new strokes, so nothing old is lost on
  // later edits.
  hasBg?: boolean;
  // Pictures placed on the board (pasted screenshots and the like), stored as their
  // own blob (<id>-img) so the strokes blob stays small and text-shaped.
  hasImgs?: boolean;
  // Widgets placed on the board: the same kind of object, holding a component instead
  // of pixels, in their own blob (<id>-wid) with the state each one has saved.
  hasWidgets?: boolean;
  // Still being written: the editor autosaved it so nothing can be lost, but it has
  // never been handed in. Nothing transcribes a draft, here or on the next app start,
  // because reading a half-written page costs a model call and says little. Finishing
  // the note in the editor clears the flag and asks for the transcript.
  draft?: boolean;
  extracted: boolean; // transcript ready (typed notes are born extracted)
  lang?: string;
}

export const INBOX_ID = 'inbox';
const NOTES_COL = 'notes';
const FOLDERS_COL = 'notefolders';
// The transcriber is the one background model worth choosing deliberately: it reads
// handwriting, so a weaker one shows up as misread words rather than as a slower answer.
// Picked in Presets (`api.noteModel`), defaulting to the model that reads every other
// page in the app. It asks for no thinking, and that is a measured choice rather than a
// thrifty one: the same page came back in 7s against 35s, and the fast reading was the
// accurate one (config/settings.json, api.noteEffort).
const extractModel = (): string => settings.api.noteModel || 'gemma4:e4b';
const MAX_AUTO_EXTRACT = 8; // failed extractions retried per session, bounded

export const notesStore = reactive({
  folders: [] as NoteFolder[],
  notes: [] as Note[],
  ready: false,
  /**
   * Note id to "3/12" while a note is being read region by region. A board of twenty
   * pages is a couple of minutes of requests, and a label that never moves for two
   * minutes is indistinguishable from one that has died.
   */
  reading: {} as Record<string, string>,
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
      console.warn('[nuclear-learning] notes load failed:', err);
    }
  } else {
    console.warn('[nuclear-learning] file database unavailable: notes will not persist this session.');
  }
  // The Inbox always exists: quick capture must never ask where to file first.
  if (!notesStore.folders.some((f) => f.id === INBOX_ID)) {
    const inbox: NoteFolder = { id: INBOX_ID, name: 'Inbox', parentId: null };
    notesStore.folders.push(inbox);
    void persistFolder(inbox);
  }
  notesStore.ready = true;
  const pending = notesStore.notes
    .filter((n) => n.hasImage && !n.extracted && !n.draft)
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

export function setFolderContext(id: string, context: string): void {
  const f = folderById(id);
  if (!f) return;
  f.context = context;
  void persistFolder(f);
}

/**
 * The context of a folder and every folder above it, outermost first, skipping the
 * empty ones. "Kryptografie" sets the module, "Block 1" narrows it, and a question
 * about a note in Block 1 should carry both.
 */
export function folderContextChain(folderId: string): { path: string; context: string }[] {
  const chain: { path: string; context: string }[] = [];
  const guard = new Set<string>();
  let cur = folderById(folderId);
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    const text = (cur.context ?? '').trim();
    if (text) chain.unshift({ path: folderPath(cur.id), context: text });
    cur = cur.parentId ? folderById(cur.parentId) : undefined;
  }
  return chain;
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
  input: {
    image: string;
    thumb: string;
    strokes?: unknown[];
    images?: unknown[];
    widgets?: unknown[];
    draft?: boolean;
  },
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
    hasImgs: Boolean(input.images?.length),
    hasWidgets: Boolean(input.widgets?.length),
    draft: input.draft || undefined,
    extracted: false,
  };
  notesStore.notes.unshift(n);
  await persistNote(n);
  if (dbState.available) {
    await blobPut(NOTES_COL, n.id, input.image);
    if (input.strokes?.length) await blobPut(NOTES_COL, `${n.id}-ink`, JSON.stringify(input.strokes));
    if (input.images?.length) await blobPut(NOTES_COL, `${n.id}-img`, JSON.stringify(input.images));
    if (input.widgets?.length) {
      await blobPut(NOTES_COL, `${n.id}-wid`, JSON.stringify(input.widgets));
    }
  }
  // A draft is the editor putting the writing somewhere safe, not a note handed in:
  // there is nothing to transcribe yet and the pen is still on the page.
  if (!input.draft) void extractNote(n.id);
  return n;
}

/**
 * Autosave for a note being written: the same bytes as a commit, and none of the
 * pipeline. Strokes and pictures go to disk, the picture of the board and its
 * thumbnail follow when the editor asks for a fresh one, and the transcript, the
 * tags, the title and the `extracted` flag are left exactly as they are.
 *
 * No model call happens on this path, ever. That is the whole contract: writing must
 * be safe from the first line without spending anything to read a page mid-sentence.
 */
export async function saveInkProgress(
  id: string,
  input: {
    image?: string;
    thumb?: string;
    strokes: unknown[];
    images?: unknown[];
    widgets?: unknown[];
    bg?: string;
  },
): Promise<void> {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n) return;
  n.hasInk = input.strokes.length > 0;
  n.hasImgs = Boolean(input.images?.length);
  n.hasWidgets = Boolean(input.widgets?.length);
  if (input.thumb) n.thumb = input.thumb;
  if (input.image) n.hasImage = true;
  if (input.bg) n.hasBg = true;
  n.edited = Date.now();
  await persistNote(n);
  if (!dbState.available) return;
  if (input.bg) await blobPut(NOTES_COL, `${id}-bg`, input.bg);
  if (input.image) await blobPut(NOTES_COL, id, input.image);
  await blobPut(NOTES_COL, `${id}-ink`, JSON.stringify(input.strokes));
  // Written even when empty, so removing the last picture actually removes it.
  await blobPut(NOTES_COL, `${id}-img`, JSON.stringify(input.images ?? []));
  await blobPut(NOTES_COL, `${id}-wid`, JSON.stringify(input.widgets ?? []));
}

/**
 * Finish an ink note: fresh image, thumb, and strokes; the transcript re-extracts
 * (the ink is its source of truth) while the title, tags, and the user's context
 * stay. This is the commit the Save button makes, as opposed to the autosave above,
 * and it is where a draft stops being one.
 */
export async function updateNoteInk(
  id: string,
  input: {
    image: string;
    thumb: string;
    strokes: unknown[];
    images?: unknown[];
    widgets?: unknown[];
    bg?: string;
  },
): Promise<void> {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n) return;
  n.thumb = input.thumb;
  n.hasImage = true;
  n.hasInk = input.strokes.length > 0;
  n.hasImgs = Boolean(input.images?.length);
  n.hasWidgets = Boolean(input.widgets?.length);
  if (input.bg) n.hasBg = true;
  n.text = '';
  n.draft = false;
  n.extracted = false;
  n.edited = Date.now();
  await persistNote(n);
  if (dbState.available) {
    if (input.bg) await blobPut(NOTES_COL, `${id}-bg`, input.bg);
    await blobPut(NOTES_COL, id, input.image);
    await blobPut(NOTES_COL, `${id}-ink`, JSON.stringify(input.strokes));
    // Written even when empty, so removing the last picture actually removes it.
    await blobPut(NOTES_COL, `${id}-img`, JSON.stringify(input.images ?? []));
    await blobPut(NOTES_COL, `${id}-wid`, JSON.stringify(input.widgets ?? []));
  }
  void extractNote(id);
}

/**
 * Replace a note's PICTURE and nothing else. The picture and its thumbnail are a
 * render of the strokes, re-made on every save, so re-making them is not an edit to
 * the note: the transcript, the tags, the title, the draft flag and the edited stamp
 * are all left exactly as they are, and the notebook does not reorder itself because
 * a picture was refreshed. Used by the ink recolour (stores/inkColor.ts).
 */
export async function setNotePreview(
  id: string,
  input: { image: string; thumb: string },
): Promise<void> {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n || !input.image) return;
  n.thumb = input.thumb;
  n.hasImage = true;
  await persistNote(n);
  if (dbState.available) await blobPut(NOTES_COL, id, input.image);
}

export async function loadNoteBg(id: string): Promise<string> {
  try {
    if (!dbState.available) return '';
    return await blobGet(NOTES_COL, `${id}-bg`);
  } catch {
    return '';
  }
}

/** The pictures placed on a note's board, if it has any. */
export async function loadNoteImages(id: string): Promise<unknown[] | null> {
  try {
    if (!dbState.available) return null;
    const raw = await blobGet(NOTES_COL, `${id}-img`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The widgets a note has on its board, with whatever state each one had saved. */
export async function loadNoteWidgets(id: string): Promise<unknown[] | null> {
  try {
    if (!dbState.available) return null;
    const raw = await blobGet(NOTES_COL, `${id}-wid`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown[];
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
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

// ---- documents: Word, PDF and anything else, filed straight into a folder ----

/**
 * A note can be a document you already have. Dropping a file into a folder (or
 * picking it with the + File button) stores its bytes beside the handwritten ones,
 * and from there it behaves like any other note: it sits in a folder, it is found by
 * search, it attaches to a chat as text, and it can be looked at without leaving the
 * app. The point is that the paper trail of a module lives in ONE place.
 */

/** What the app can do with a filed document, decided from its type once. */
export type DocKind = 'image' | 'pdf' | 'word' | 'text' | 'other';

const TEXTUAL = /\.(txt|md|markdown|csv|tsv|json|ya?ml|tex|bib|log|html?|xml|js|ts|py|java|c|cpp|cs|rs|go|sql|sh)$/i;
const MAX_FILE_MB = 20; // the file database takes 32 MB bodies; base64 costs a third
const MAX_DOC_TEXT = 200_000; // matches the server-side transcription cap

export function docKind(f?: NoteFile): DocKind {
  if (!f) return 'other';
  const name = f.name.toLowerCase();
  if (f.mime.startsWith('image/')) return 'image';
  if (f.mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  if (name.endsWith('.docx')) return 'word';
  if (f.mime.startsWith('text/') || TEXTUAL.test(name)) return 'text';
  return 'other';
}

export function readAsDataUrl(f: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(f);
  });
}

function textFromDataUrl(url: string): string {
  const comma = url.indexOf(',');
  if (comma < 0) return '';
  const body = url.slice(comma + 1);
  if (!/;base64/i.test(url.slice(0, comma))) return decodeURIComponent(body);
  try {
    const bin = atob(body);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder('utf-8').decode(bytes);
  } catch {
    return '';
  }
}

/**
 * The document's own bytes, served by the dev server with its real content-type, so
 * a PDF opens in the browser's viewer and Download saves the file under its name.
 */
export function noteFileUrl(n: Note, download = false): string {
  const q = new URLSearchParams({ name: n.file?.name ?? 'document' });
  if (download) q.set('dl', '1');
  return `/api/db/file/${NOTES_COL}/${n.id}?${q.toString()}`;
}

/**
 * Hand a Word file to Word itself. Office registers the ms-word: scheme on both
 * macOS and Windows, and "ofe|u|" means "open for edit, this URL". A plain link to
 * the file route cannot do this: the server sends the real Word content-type, and a
 * browser answers that with a download, which is what made the Open button feel
 * broken. The URL has to be absolute, since the handler leaves the page's context.
 */
export function noteWordUrl(n: Note): string {
  const abs = new URL(noteFileUrl(n), window.location.origin).href;
  return `ms-word:ofe|u|${abs}`;
}

/** A Word document as viewable HTML plus its plain text (see server/docx.ts). */
export async function loadDocxView(id: string): Promise<{ html: string; text: string } | null> {
  try {
    if (!dbState.available) return null;
    const res = await fetch(`/api/db/docx/${NOTES_COL}/${id}`);
    if (!res.ok) return null;
    return (await res.json()) as { html: string; text: string };
  } catch {
    return null;
  }
}

/** A Word document carries its own text: keep it so search and chats can use it. */
async function extractDocText(id: string): Promise<void> {
  const view = await loadDocxView(id);
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n || !view?.text || n.text) return;
  n.text = view.text.slice(0, MAX_DOC_TEXT);
  n.extracted = true;
  n.edited = Date.now();
  await persistNote(n);
}

export async function saveFileNote(file: File, folderId: string = INBOX_ID): Promise<Note> {
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    throw new Error(
      `"${file.name}" is ${(file.size / 1048576).toFixed(1)} MB and the limit is ${MAX_FILE_MB} MB`,
    );
  }
  const dataUrl = await readAsDataUrl(file);
  const meta: NoteFile = { name: file.name, mime: file.type || '', size: file.size };
  const kind = docKind(meta);
  const n: Note = {
    id: newId(),
    ts: Date.now(),
    edited: Date.now(),
    folderId: folderById(folderId) ? folderId : INBOX_ID,
    // A file arrives with a name, so the note has one from the start. It is a title
    // like any other: yours to rename, and nothing overwrites it later.
    title: file.name.replace(/\.[^.]+$/, ''),
    text: kind === 'text' ? textFromDataUrl(dataUrl).slice(0, MAX_DOC_TEXT) : '',
    context: '',
    tags: [],
    pinned: false,
    source: 'file',
    thumb: kind === 'image' ? await makeThumb(dataUrl) : '',
    hasImage: kind === 'image',
    file: meta,
    // Only a picture has handwriting to read. A Word file carries its own text, and
    // the rest are viewed as they are.
    extracted: kind !== 'image' && kind !== 'word',
  };
  notesStore.notes.unshift(n);
  await persistNote(n);
  if (dbState.available) {
    await blobPut(NOTES_COL, n.id, dataUrl);
    if (kind === 'image') void extractNote(n.id);
    if (kind === 'word') void extractDocText(n.id);
  }
  return n;
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
      await colDelete(NOTES_COL, `${id}-img`);
      await colDelete(NOTES_COL, `${id}-wid`);
      // The retrieval index too, by collection name rather than by importing
      // retrieval.ts, which imports this module and would close the cycle.
      await colDelete('vectors', id);
    } catch (err) {
      console.warn('[nuclear-learning] note delete failed:', err);
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

/**
 * What every request about a picture of handwriting asks for, and why none of them ask
 * for it as JSON.
 *
 * A transcript of handwritten mathematics is mostly backslashes, and a small model
 * writing $\neq$ inside a JSON string does not escape it. JSON.parse then reads \n as a
 * newline and leaves "eq" behind, \frac as a form feed and "rac", \begin as a backspace
 * and "egin". A whole page of algebra came back shredded that way while looking, line by
 * line, like it had been read correctly. So the transcript is asked for as itself: it is
 * the entire answer, nothing about it needs a wrapper, and nothing has to survive an
 * escaping round trip.
 *
 * What a note needs on top of its text (a name to offer, tags, the language) is asked
 * for afterwards by describeNote, where the answer is a few plain words and a schema
 * costs nothing.
 */
const TRANSCRIBE_RULES = `- Preserve the structure: line breaks, bullets, numbering, headings.
- Write every mathematical expression in $-LaTeX between single $ delimiters.
- Mark genuinely unreadable spots as [?].
- Never summarize, never translate, never add anything that is not written.
- Reply with the transcription and nothing else: no preamble, no commentary, no code fence, no JSON.`;

const PAGE_SYSTEM = `You transcribe handwriting. The image is ONE handwritten note, which may be about anything (mathematics, code, ideas, plans, lists) and stays in its own language.

${TRANSCRIBE_RULES}`;

/**
 * A note too big to stay legible in one picture is cut into regions that do not overlap
 * and read one request per region, in reading order. Each request sees exactly one
 * region and is told to stay inside it, which is the other half of the repair: a small
 * local model handed twelve pictures in one request stops transcribing a page and starts
 * producing something that merely looks like notes.
 */
const REGION_SYSTEM = `You transcribe handwriting. The image is ONE REGION of a handwritten note, which was cut top to bottom into regions that do not overlap. Every other region is transcribed by its own separate request, and the note stays in its own language.

Transcribe all of THIS image and nothing beyond it. Do not guess at what came before this region or after it, and do not repeat a heading that is not on this image. A line the cut caught part-way through is transcribed as far as you can read it, with [?] for the rest.

${TRANSCRIBE_RULES}`;

const DESCRIBE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'tags', 'language'],
  properties: {
    title: { type: 'string' },
    tags: { type: 'array', items: { type: 'string' } },
    language: { type: 'string' },
  },
};

const DESCRIBE_SYSTEM = `You are given the transcript of ONE handwritten note, as it was just read off the page. Describe it for a personal knowledge base.

Return JSON:
- "title": a name for this note, at most 60 characters, in the note's own language. Say what is ON the page as concretely as the page allows ("Grenzwerte: Sandwich-Satz mit Beispielen"), and take the note's own heading when it has one. No date, no filler ("Notizen zu ..."), no trailing punctuation. It is offered to the student, who decides whether to use it.
- "tags": 3 to 8 lowercase tags a searcher would type, in the note's language plus obvious English equivalents, no duplicates.
- "language": the note's main language as a two-letter code ("de", "en").`;

function decodeImage(imageDataUrl: string): { data: string; mediaType: string } {
  const match = /^data:(image\/[a-z]+);base64,(.*)$/s.exec(imageDataUrl);
  return {
    mediaType: match?.[1] ?? 'image/jpeg',
    data: match?.[2] ?? imageDataUrl.replace(/^data:[^,]*,/, ''),
  };
}

/**
 * The pictures the transcriber is given, in the order a reader would take them.
 *
 * A note written on the board can cover more surface than one image carries legibly, so
 * its stored strokes are re-rendered as per-region tiles: the ink comes back at full pen
 * weight and the empty board between regions is never sent at all. A page-sized note
 * yields a single tile and is exactly the one-image request it always was.
 *
 * A screenshot pasted onto the board goes in as its own region, at the size it was
 * pasted at, and takes its place among the ink by where it sits on the page. That is
 * usually the half that matters: a page of worked answers whose questions are pasted
 * above them transcribed as answers to nothing at all, because the tiles are drawn from
 * strokes and a picture has none. Sending it whole rather than redrawn also keeps
 * printed text as sharp as it arrived.
 *
 * Two kinds of note keep their stored image instead. One with a backdrop has a raster
 * layer under the ink that redrawing strokes cannot reproduce, and one without stored
 * strokes (a pasted screenshot on its own, or a capture from before ink was persisted)
 * has no strokes to redraw. Both are page-sized by construction, so nothing is lost.
 */
async function extractImages(n: Note): Promise<string[]> {
  if (n.hasInk && !n.hasBg) {
    const strokes = (await loadNoteInk(n.id)) as TabletStroke[] | null;
    if (strokes?.length) {
      const tiles = exportInkTiles(strokes, 'all').filter((t) => t.image);
      const pics = n.hasImgs ? ((await loadNoteImages(n.id)) as TabletImage[] | null) ?? [] : [];
      const regions = inReadingOrder([
        ...tiles,
        ...pics.filter((p) => p?.src).map((p) => ({ image: p.src, box: imageBox(p) })),
      ]);
      if (regions.length) return regions.map((r) => r.image);
    }
  }
  const image = await loadNoteImage(n.id);
  return image ? [image] : [];
}

/** A plain-text reply, with the code fence a chatty model sometimes wraps it in. */
function unfence(s: string): string {
  const t = s.trim();
  const fenced = /^```[a-z]*\n([\s\S]*?)\n?```$/i.exec(t);
  return (fenced ? fenced[1] : t).trim();
}

/**
 * One region, read as text. Returns null when the call failed, which the caller marks in
 * the transcript rather than treating as the end of the note. An empty region is not a
 * failure: a crop can legitimately hold nothing readable.
 */
async function runRegion(image: string, index: number, total: number): Promise<string | null> {
  const { data, mediaType } = decodeImage(image);
  const text =
    total > 1
      ? `This is region ${index + 1} of ${total} of one note, in reading order. Transcribe only what is written in this image.`
      : 'Transcribe this note.';
  try {
    const model = extractModel();
    const resp = await createCompletion(
      {
        model,
        // One region is at most a page of writing, and the reply is that page as text.
        max_completion_tokens: 6000,
        reasoning_effort: settings.api.noteEffort || 'none',
        messages: [
          { role: 'system', content: total > 1 ? REGION_SYSTEM : PAGE_SYSTEM },
          {
            role: 'user',
            content: [
              { type: 'text', text },
              { type: 'image_url', image_url: { url: `data:${mediaType};base64,${data}` } },
            ],
          },
        ],
      },
      { timeout: 120000, lane: 'background' },
    );
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: 'notes',
      model,
      role: 'note',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
    });
    return unfence(cleanText(resp.choices?.[0]?.message?.content ?? ''));
  } catch (err) {
    console.warn(`[nuclear-learning] region ${index + 1}/${total} failed:`, err);
    return null;
  }
}

/**
 * Read a set of region images and hand back one transcript.
 *
 * The regions go out one request at a time, in reading order, and their transcripts are
 * joined in that order. They used to ride in a single request as a dozen pictures with
 * an instruction to read them as one continuous page, which a hosted model could do and
 * this one cannot: a twenty-page board came back as a few real lines followed by dots
 * and question marks, invented rather than read. One picture per request is the fix, and
 * the reason the regions no longer overlap (inkExport): two requests cannot agree about
 * a line they can both see, so a shared seam came back transcribed twice.
 *
 * A region that fails is skipped rather than fatal. Losing one page of twenty is worth
 * far more than losing the other nineteen to it, and the gap is marked in the transcript
 * so it never reads as writing that was never there.
 *
 * Both readers go through here: the note's own transcription, and the live read the
 * question window asks for. That is what keeps those two the SAME reading, on the same
 * model, so an answer about the page is never based on a weaker look at it.
 */
async function runTranscription(
  images: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<string> {
  const total = images.length;
  const parts: string[] = [];
  let failed = 0;
  for (let i = 0; i < total; i += 1) {
    const out = await runRegion(images[i], i, total);
    if (out === null) {
      failed += 1;
      if (total > 1) parts.push(`[region ${i + 1} of ${total} could not be read]`);
    } else if (out) {
      parts.push(out);
    }
    onProgress?.(i + 1, total);
  }
  if (failed === total) return '';
  return parts.join('\n\n').trim();
}

/**
 * The name, tags and language of a note, from the text that was just read off it. One
 * small text call, no picture: the page has already been read, and reading it twice to
 * learn what language it is in would double what a note costs to file.
 *
 * Failing here costs the note nothing but its tags: the transcript is already in hand.
 */
async function describeNote(text: string): Promise<{ title: string; tags: string[]; lang: string }> {
  const empty = { title: '', tags: [] as string[], lang: '' };
  const body = text.trim().slice(0, 4000);
  if (!body) return empty;
  try {
    const model = settings.api.backgroundModel || 'gemma4:e4b';
    const resp = await createCompletion(
      {
        model,
        max_completion_tokens: 1000,
        reasoning_effort: 'none',
        messages: [
          { role: 'system', content: DESCRIBE_SYSTEM },
          { role: 'user', content: body },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'note_describe', strict: true, schema: DESCRIBE_SCHEMA },
        },
      },
      { timeout: 60000, lane: 'background' },
    );
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: 'notes',
      model,
      role: 'note',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
    });
    const parsed = JSON.parse((resp.choices?.[0]?.message?.content ?? '').trim()) as {
      title?: string;
      tags?: unknown;
      language?: string;
    };
    return {
      title: cleanText(parsed.title).trim().slice(0, 80),
      tags: Array.isArray(parsed.tags)
        ? parsed.tags
            .filter((t): t is string => typeof t === 'string')
            .map((t) => cleanText(t).trim().toLowerCase())
            .filter(Boolean)
            .slice(0, 8)
        : [],
      lang: typeof parsed.language === 'string' ? parsed.language.slice(0, 5) : '',
    };
  } catch (err) {
    console.warn('[nuclear-learning] describing a note failed:', err);
    return empty;
  }
}

/** One background vision call per note; the learner's own edits always win over a re-run. */
export async function extractNote(id: string): Promise<boolean> {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n || !n.hasImage) return false;
  try {
    const images = await extractImages(n);
    if (!images.length) return false;
    const transcript = await runTranscription(images, (done, total) => {
      // Only a note that was cut up has anything to count; a single page says
      // "transcribing" the way it always did.
      if (total > 1) notesStore.reading[id] = `${done}/${total}`;
    });
    if (!transcript) return false;
    const meta = await describeNote(transcript);
    // Hand-edited fields survive a re-extract; only the untouched ones fill in.
    // The title is never among them: it is the student's, and a transcription
    // landing minutes later must not rename a note they just named themselves.
    // The candidate is parked in titleHint, where the button in the note dialog can
    // hand it over for nothing.
    if (meta.title) n.titleHint = meta.title;
    if (!n.text) n.text = transcript;
    if (!n.tags.length && meta.tags.length) n.tags = meta.tags;
    if (meta.lang) n.lang = meta.lang;
    n.extracted = true;
    n.edited = Date.now();
    await persistNote(n);
    return true;
  } catch (err) {
    // Every caller fires this and walks away, so a throw here would surface as an
    // unhandled rejection rather than as a note that stayed untranscribed.
    console.warn('[nuclear-learning] transcribing a note failed:', err);
    return false;
  } finally {
    delete notesStore.reading[id];
  }
}

/**
 * Read a board that is being written RIGHT NOW, and hand the text back without
 * touching any note. The question window over the editor needs to know what is on the
 * page, and the page it is looking at is usually newer than the note's stored
 * transcript; writing this into the note instead would overwrite a transcript the
 * student may have corrected by hand.
 *
 * `maxRegions` is what keeps this usable on a board that has grown over a term. A note
 * is read region by region, so a twenty-region board is a couple of minutes, and a
 * question is not worth a couple of minutes of silence. Above the cap only the newest
 * corner of the board is read: the region holding the most recent stroke and the ones
 * above it, which is the working you were looking at when you typed the question. The
 * full read still happens where it belongs, when the note is saved.
 *
 * The caller caches the result against the board's revision, so this runs when the
 * page has actually changed and never once per question.
 */
export async function transcribeStrokes(
  strokes: TabletStroke[],
  maxRegions = 0,
): Promise<string> {
  const tiles = exportInkTiles(strokes, 'all').filter((t) => t.image);
  if (!tiles.length) return '';
  let use = tiles;
  if (maxRegions > 0 && tiles.length > maxRegions) {
    const newest = strokes.reduce((a, b) => (b.id > a.id ? b : a), strokes[0]);
    let at = tiles.findIndex(
      (t) =>
        newest.minX <= t.box.maxX &&
        newest.maxX >= t.box.minX &&
        newest.minY <= t.box.maxY &&
        newest.maxY >= t.box.minY,
    );
    if (at < 0) at = tiles.length - 1;
    use = tiles.slice(Math.max(0, at - (maxRegions - 1)), at + 1);
  }
  return runTranscription(use.map((t) => t.image));
}

// ---- naming a note, on request ----

const TITLE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: { title: { type: 'string' } },
};

const TITLE_SYSTEM = `You name ONE note in a student's knowledge base. You are given what the note holds: the student's own context for it, and its text.

Return JSON with "title": at most 60 characters, in the note's own language, saying what is ON the page as concretely as the page allows ("Grenzwerte: Sandwich-Satz mit Beispielen"). Take the note's own heading when it has one. No date, no filler ("Notizen zu ..."), no trailing punctuation.`;

/**
 * A name for a note, when the student asks for one. The transcriber already read the
 * page and left its candidate behind, so the ordinary case spends nothing: the button
 * hands over what that one call produced. A note with no candidate (typed by hand,
 * filed as a document, or transcribed before candidates were kept) costs one small
 * text call over what it already holds, and a page nobody has read yet is read first,
 * which is the call it was owed anyway.
 *
 * Returns '' when there is nothing to go on. Never writes to the note's own title:
 * that stays a field only the student and the button they pressed can fill.
 */
export async function suggestTitle(id: string): Promise<string> {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n) return '';
  if (n.titleHint?.trim()) return n.titleHint.trim();
  // A page that has never been transcribed: reading it is what naming it needs, and
  // it fills the transcript and tags at the same time.
  if (!n.text.trim() && !n.context.trim() && n.hasImage) {
    await extractNote(id);
    return n.titleHint?.trim() ?? '';
  }
  const body = [n.context.trim(), n.text.trim()].filter(Boolean).join('\n\n').slice(0, 4000);
  if (!body) return '';
  try {
    const model = settings.api.backgroundModel || 'gemma4:e4b';
    const params: any = {
      model,
      max_completion_tokens: 2000, // a title is ten tokens; the rest is room to be wrong in
      messages: [
        { role: 'system', content: TITLE_SYSTEM },
        { role: 'user', content: body },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'note_title', strict: true, schema: TITLE_SCHEMA },
      },
    };
    if (modelInfo(model).effort) params.reasoning_effort = 'none';
    const resp = await createCompletion(params, { timeout: 45000, lane: 'background' });
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: 'notes',
      model,
      role: 'note',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
    });
    const parsed = JSON.parse((resp.choices?.[0]?.message?.content ?? '').trim()) as { title?: string };
    const title = cleanText(parsed.title).trim().slice(0, 80);
    if (!title) return '';
    n.titleHint = title;
    await persistNote(n);
    return title;
  } catch (err) {
    console.warn('[nuclear-learning] naming a note failed:', err);
    return '';
  }
}

/** Force a fresh transcription: clears the machine-filled fields first, keeps the title/pin/folder. */
export async function reExtractNote(id: string): Promise<boolean> {
  const n = notesStore.notes.find((x) => x.id === id);
  if (!n || !n.hasImage) return false;
  n.text = '';
  n.tags = [];
  // Asking for the transcript is finishing the note, whether or not it went through
  // the editor's Save button.
  n.draft = false;
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
      // A note is findable by what its module says about itself, not only by what
      // is written on the page.
      [normText(folderContextChain(n.folderId).map((f) => f.context).join(' ')), 1],
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
export interface AskFolderContext {
  path: string;
  context: string;
}

export function resolveAskNotes(
  noteIds: string[],
  folderIds: string[],
  capChars = 9000,
): { notes: AskNote[]; folders: AskFolderContext[]; omitted: number; pending: number } {
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
  // Folder background for everything that made it in, plus every folder picked
  // outright. Deduped by path and kept outermost-first, so a module's framing is
  // stated once no matter how many of its notes came along.
  const seen = new Set<string>();
  const folders: AskFolderContext[] = [];
  const take = (chain: { path: string; context: string }[]) => {
    for (const entry of chain) {
      if (seen.has(entry.path)) continue;
      seen.add(entry.path);
      folders.push(entry);
    }
  };
  for (const fid of folderIds) take(folderContextChain(fid));
  for (const n of ordered) take(folderContextChain(n.folderId));
  folders.sort((a, b) => a.path.length - b.path.length);
  return { notes, folders, omitted, pending };
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
