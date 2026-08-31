<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import BoardWidget from '@/components/BoardWidget.vue';
import ConfirmButton from '@/components/ConfirmButton.vue';
import FloatWindow from '@/components/FloatWindow.vue';
import MathText from '@/components/MathText.vue';
import {
  useTablet,
  type TabletImage,
  type TabletStroke,
  type TabletWidget,
} from '@/composables/useTablet';
import { WIDGET_SEED } from '@/widgetHost';
import { holdDue } from '@/composables/holdRepeat';
import { makeThumb } from '@/stores/archive';
import { inkedBackdrop } from '@/stores/inkColor';
import {
  DRAFT_KEY,
  adoptThread,
  askNote,
  clearThread,
  noteAskStore,
  thread,
} from '@/stores/noteAsk';
import {
  INBOX_ID,
  addFolder,
  addTypedNote,
  deleteFolder,
  deleteNote,
  docKind,
  folderById,
  folderContextChain,
  folderPath,
  folderTree,
  setFolderContext,
  loadDocxView,
  loadNoteBg,
  loadNoteImage,
  loadNoteImages,
  loadNoteWidgets,
  loadNoteInk,
  noteFileUrl,
  noteWordUrl,
  notesInFolder,
  notesStore,
  reExtractNote,
  readAsDataUrl,
  renameFolder,
  saveFileNote,
  saveInkProgress,
  saveNoteFromPad,
  searchNotes,
  suggestTitle,
  transcribeStrokes,
  updateNote,
  updateNoteInk,
  type DocKind,
  type Note,
  type NoteFolder,
} from '@/stores/notes';

// The Notebook: the notes half of Notes mode, purely about capturing and organizing.
// School notes of any subject are written HERE (own ink editor, no grader, no
// scratch divider), organized into nested folders with tags, searched as text.
// Questions about them belong to the Chat window next door, which attaches these
// notes as transcripts; the math tutor never sees them unless a math page attaches
// them on the pad.

const selected = ref<string>(''); // '' = all notes
const query = ref('');

/** An inline field that replaces a row is useless if you have to click it first. */
const vFocus = {
  mounted: (el: HTMLInputElement) => {
    el.focus();
    el.select();
  },
};

const tree = computed(() => folderTree());
const results = computed(() => searchNotes(query.value, selected.value || undefined));
const countIn = (folderId: string) => notesInFolder(folderId, true).length;

// ---- the folder tree: collapsible, and it remembers ----

// Folders start open (a tree that hides what you filed is worse than a long one),
// so only the ids explicitly collapsed are stored. nl.* keys mirror to disk.
const COLLAPSED_KEY = 'nl.notesCollapsed.v1';

function loadCollapsed(): Set<string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

const collapsed = ref(loadCollapsed());

function toggleFolder(id: string): void {
  if (collapsed.value.has(id)) collapsed.value.delete(id);
  else collapsed.value.add(id);
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed.value]));
  } catch {
    /* storage unavailable, non-fatal */
  }
}

const childCount = computed(() => {
  const m = new Map<string, number>();
  for (const f of notesStore.folders) {
    if (f.parentId) m.set(f.parentId, (m.get(f.parentId) ?? 0) + 1);
  }
  return m;
});

/**
 * The rows actually drawn. folderTree() is a depth-first list with depths, so
 * everything under a collapsed folder is exactly the run of deeper rows that
 * follows it.
 */
const visibleTree = computed(() => {
  const out: { folder: NoteFolder; depth: number; kids: number }[] = [];
  let hideBelow = -1;
  for (const t of tree.value) {
    if (hideBelow >= 0 && t.depth > hideBelow) continue;
    hideBelow = -1;
    const kids = childCount.value.get(t.folder.id) ?? 0;
    out.push({ folder: t.folder, depth: t.depth, kids });
    if (kids && collapsed.value.has(t.folder.id)) hideBelow = t.depth;
  }
  return out;
});

// ---- custom-resizable notebook: pane and window sizes are the user's, persisted ----

const PANES_KEY = 'nl.panes.v1'; // mirrored to disk like every nl.* key
const TREE_W_DEFAULT = 240;

function loadPanes(): Record<string, number> {
  try {
    const parsed = JSON.parse(localStorage.getItem(PANES_KEY) || '{}') as Record<string, number>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function savePane(key: string, value: number): void {
  const all = loadPanes();
  all[key] = Math.round(value);
  try {
    localStorage.setItem(PANES_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable, non-fatal */
  }
}

function paneOr(key: string, fallback: number, min: number): number {
  const v = loadPanes()[key];
  return Number.isFinite(v) && v >= min ? v : fallback;
}

// The folder tree: a drag handle beside it sets its width.
const treeW = ref(Math.min(520, paneOr('notesTree', TREE_W_DEFAULT, 150)));

function startTreeDrag(e: PointerEvent): void {
  const grip = e.currentTarget as HTMLElement;
  e.preventDefault();
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {
    /* best-effort */
  }
  const startX = e.clientX;
  const startW = treeW.value;
  const move = (ev: PointerEvent) => {
    treeW.value = Math.min(520, Math.max(150, startW + ev.clientX - startX));
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    savePane('notesTree', treeW.value);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
}

function resetTreeW(): void {
  treeW.value = TREE_W_DEFAULT;
  savePane('notesTree', TREE_W_DEFAULT);
}

// The note window: its corner grip resizes it freely; the size sticks across
// notes and sessions. 0 = the stock CSS size.
const noteWinRef = ref<HTMLDivElement | null>(null);
const noteW = ref(paneOr('noteW', 0, 420));
const noteH = ref(paneOr('noteH', 0, 300));

const noteWinStyle = computed(() =>
  noteW.value && noteH.value
    ? { width: `${noteW.value}px`, height: `${noteH.value}px` }
    : {},
);

function startWinDrag(e: PointerEvent): void {
  const el = noteWinRef.value;
  const grip = e.currentTarget as HTMLElement;
  if (!el) return;
  e.preventDefault();
  try {
    grip.setPointerCapture(e.pointerId);
  } catch {
    /* best-effort */
  }
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = el.offsetWidth;
  const startH = el.offsetHeight;
  const move = (ev: PointerEvent) => {
    noteW.value = Math.max(420, startW + (ev.clientX - startX));
    noteH.value = Math.max(300, startH + (ev.clientY - startY));
  };
  const up = () => {
    grip.removeEventListener('pointermove', move);
    grip.removeEventListener('pointerup', up);
    savePane('noteW', noteW.value);
    savePane('noteH', noteH.value);
  };
  grip.addEventListener('pointermove', move);
  grip.addEventListener('pointerup', up);
}

function resetWinSize(): void {
  noteW.value = 0;
  noteH.value = 0;
  savePane('noteW', 0);
  savePane('noteH', 0);
}

// ---- documents: dropped in, or picked with the button ----

const fileInputRef = ref<HTMLInputElement | null>(null);
const fileBusy = ref(0);
const fileError = ref('');
// Drag events fire again for every child element the pointer crosses, so the
// highlight counts enter/leave pairs instead of trusting a single leave.
const dropDepth = ref(0);
const dragNote = ref(''); // the note being dragged onto a folder, if any
const dropTarget = ref(''); // the folder row under the pointer

function hasFiles(e: DragEvent): boolean {
  return Boolean(e.dataTransfer?.types.includes('Files'));
}

/** File a batch into one folder, one by one, so one bad file cannot stop the rest. */
async function fileInto(files: FileList | File[] | null, folderId: string): Promise<void> {
  const list = [...(files ?? [])];
  if (!list.length) return;
  fileError.value = '';
  fileBusy.value += list.length;
  for (const f of list) {
    try {
      const n = await saveFileNote(f, folderId);
      selected.value = n.folderId;
    } catch (err) {
      fileError.value = err instanceof Error ? err.message : String(err);
      console.warn('[nuclear-learning] filing a document failed:', err);
    } finally {
      fileBusy.value -= 1;
    }
  }
}

function pickFiles(): void {
  fileInputRef.value?.click();
}

async function onFilePicked(e: Event): Promise<void> {
  const input = e.target as HTMLInputElement;
  await fileInto(input.files, selected.value || INBOX_ID);
  input.value = ''; // the same file can be filed again later
}

function onPaneDragEnter(e: DragEvent): void {
  if (hasFiles(e)) dropDepth.value += 1;
}

function onPaneDragOver(e: DragEvent): void {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
}

function onPaneDragLeave(e: DragEvent): void {
  if (hasFiles(e)) dropDepth.value = Math.max(0, dropDepth.value - 1);
}

async function onPaneDrop(e: DragEvent): Promise<void> {
  dropDepth.value = 0;
  if (!e.dataTransfer?.files.length) return;
  e.preventDefault();
  await fileInto(e.dataTransfer.files, selected.value || INBOX_ID);
}

// A folder row takes both kinds of drag: files from the desktop land in it, and a
// note dragged out of the grid moves into it.
function onNoteDragStart(n: Note, e: DragEvent): void {
  dragNote.value = n.id;
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', n.title || 'note');
  }
}

function onFolderDragOver(id: string, e: DragEvent): void {
  const files = hasFiles(e);
  if (!files && !dragNote.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = files ? 'copy' : 'move';
  dropTarget.value = id;
}

async function onFolderDrop(id: string, e: DragEvent): Promise<void> {
  e.preventDefault();
  e.stopPropagation();
  dropTarget.value = '';
  dropDepth.value = 0;
  if (e.dataTransfer?.files.length) {
    await fileInto(e.dataTransfer.files, id);
    return;
  }
  if (dragNote.value) {
    updateNote(dragNote.value, { folderId: id });
    dragNote.value = '';
    selected.value = id;
  }
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function fileTag(n: Note): string {
  const ext = n.file?.name.split('.').pop() ?? '';
  return `${(ext || 'file').toUpperCase().slice(0, 5)} · ${fmtSize(n.file?.size ?? 0)}`;
}

// ---- clipboard: a copied image pastes straight into the notebook ----

// Cmd+V with an image (screenshot, phone photo, textbook snippet) creates an image
// note in the selected folder and the background transcriber picks it up exactly
// like a pad capture. A pasted picture has no file name, which is why this stays the
// pad path rather than the document one. Text pastes keep their default behavior.
async function onPaste(e: ClipboardEvent): Promise<void> {
  const items = e.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const it = items[i];
    if (it.kind === 'file' && it.type.startsWith('image/')) {
      const f = it.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) return;
  e.preventDefault();
  // With the ink editor open, a pasted picture belongs ON the board being written,
  // as a thing that can be moved and resized. It used to leave the editor entirely
  // and make a separate note out of the screenshot.
  if (inkOpen.value) {
    for (const f of files) {
      try {
        ink.addImage(await readAsDataUrl(f));
      } catch (err) {
        console.warn('[nuclear-learning] pasting a picture onto the board failed:', err);
      }
    }
    return;
  }
  for (const f of files) {
    try {
      const img = await readAsDataUrl(f);
      const thumb = await makeThumb(img);
      const n = await saveNoteFromPad({ image: img, thumb }, selected.value || INBOX_ID);
      selected.value = n.folderId;
    } catch (err) {
      console.warn('[nuclear-learning] image paste failed:', err);
    }
  }
}

// ---- folder actions ----

// Naming a folder happens in the tree, in the row the folder will occupy. It used
// to be window.prompt, which is an OS box with the page's hostname on it and no
// relation to the app around it.

const newFolderParent = ref<string | null | undefined>(undefined); // undefined = not adding
const newFolderName = ref('');
const renamingId = ref('');
const renameDraft = ref('');

function startNewFolder(parentId: string | null): void {
  renamingId.value = '';
  newFolderParent.value = parentId;
  newFolderName.value = '';
  if (parentId) collapsed.value.delete(parentId); // a new child must be visible
}

function commitNewFolder(): void {
  const parent = newFolderParent.value;
  if (parent === undefined) return;
  const name = newFolderName.value.trim();
  newFolderParent.value = undefined;
  newFolderName.value = '';
  if (!name) return;
  selected.value = addFolder(name, parent).id;
}

function cancelNewFolder(): void {
  newFolderParent.value = undefined;
  newFolderName.value = '';
}

function startRename(f: NoteFolder): void {
  cancelNewFolder();
  renamingId.value = f.id;
  renameDraft.value = f.name;
}

function commitRename(): void {
  const id = renamingId.value;
  renamingId.value = '';
  if (id && renameDraft.value.trim()) renameFolder(id, renameDraft.value);
}

function onDeleteFolder(id: string): void {
  deleteFolder(id);
  if (selected.value === id) selected.value = '';
}

// ---- what a folder is about: the student's own framing, inherited downwards ----

const ctxOpen = ref(false);
const folderCtxDraft = ref('');
let folderCtxTimer: number | undefined;

// Follow the selection, and never clobber a half-typed draft on the way.
watch(
  selected,
  (id) => {
    if (folderCtxTimer) window.clearTimeout(folderCtxTimer);
    folderCtxTimer = undefined;
    folderCtxDraft.value = id ? (folderById(id)?.context ?? '') : '';
  },
  { immediate: true },
);

function onFolderCtxInput(): void {
  const id = selected.value;
  if (!id) return;
  if (folderCtxTimer) window.clearTimeout(folderCtxTimer);
  folderCtxTimer = window.setTimeout(() => {
    folderCtxTimer = undefined;
    setFolderContext(id, folderCtxDraft.value);
  }, AUTOSAVE_MS);
}

// ---- the ink editor: writing notes directly, no pad involved ----

const inkOpen = ref(false);
const inkCanvasRef = ref<HTMLCanvasElement | null>(null);
const inkWrapRef = ref<HTMLDivElement | null>(null);
// scratch:false — a general note has no "not graded" region, the whole page is the note.
// board:true — the writing surface is an unbounded whiteboard, not a sheet: a note
// grows in every direction, zooms out to be seen whole, and pans like a Miro board.
const ink = useTablet(inkCanvasRef, { scratch: false, board: true, probeName: '__nlInk' });

// ---- widgets on the board ----
//
// A widget is an object on the surface like a pasted picture, except that it is the
// one the engine does not paint: it has fields you type into, so it lives as real
// elements above the canvas. The engine still owns WHERE it sits (so Fit frames it,
// the export reaches around it and one save writes it with everything else), and this
// layer owns what it looks like and what it does.
const widgets = ref<TabletWidget[]>([]);
const boardXform = ref<{ k: number; ox: number; oy: number } | null>(null);
const codingWidget = ref(0); // id of the widget whose source window is open, 0 = none
const codeDraft = ref('');

// Two different questions, so two watchers. A pan or a zoom moves every widget and
// changes nothing about them, and it happens once per frame; a change to the widgets
// themselves is rarer and has to be read back out of the engine.
watch(
  () => ink.state.viewRev,
  () => {
    boardXform.value = ink.clientTransform();
  },
);
watch(
  () => ink.state.rev,
  () => {
    widgets.value = ink.getWidgets();
  },
);

function addWidget(): void {
  ink.addWidget(WIDGET_SEED);
  boardXform.value = ink.clientTransform();
}

function onWidgetUpdate(id: number, patch: Partial<TabletWidget>): void {
  ink.updateWidget(id, patch);
}

function removeWidget(id: number): void {
  ink.removeWidget(id);
  if (codingWidget.value === id) codingWidget.value = 0;
}

function openWidgetCode(id: number): void {
  const wd = widgets.value.find((w) => w.id === id);
  if (!wd) return;
  codingWidget.value = id;
  codeDraft.value = wd.src;
}

// The source is written through as it is typed; the widget itself waits for the
// typing to stop before it rebuilds, so a half-finished line is never compiled.
watch(codeDraft, (src) => {
  if (codingWidget.value) ink.updateWidget(codingWidget.value, { src });
});
const inkFolder = ref<string>(INBOX_ID);
const inkSaving = ref(false);
// Set while an EXISTING note's ink is loaded in the editor: Save writes back to it
// (fresh image, strokes, and transcript) instead of creating a new note.
const editingNote = ref<Note | null>(null);

// Fullscreen writing: the page fills the screen, so the tablet's active area maps
// ~1:1 onto it (the page aspect already matches the tablet's).
function toggleFullscreen(): void {
  const el = inkWrapRef.value;
  if (!el) return;
  if (document.fullscreenElement) void document.exitFullscreen();
  else void el.requestFullscreen().catch(() => {});
}

function onFsChange(): void {
  ink.resize(); // the wrap's box jumps between pane and screen size
}

function openInk(): void {
  // "+ Ink note" always starts a NEW note: a leftover editing session is dropped
  // (its saved copy is untouched on disk), a plain unsaved draft is kept.
  if (editingNote.value) {
    ink.clear();
    editingNote.value = null;
    legacyBg.value = '';
    inkShotAt = 0;
    inkSavedAt.value = 0;
    markInkSaved(); // an empty board owes disk nothing
    pageText.value = '';
    pageRev.value = -1;
  }
  inkFolder.value = selected.value || INBOX_ID;
  inkOpen.value = true; // the canvas mounts and useTablet sizes it via its ref watcher
  // A new page starts at home. Without this it opened wherever the last board had been
  // panned to, which on a board is anywhere at all.
  ink.resetView();
}

// Reopen a saved note and keep writing; Save commits back to the same note. Notes
// with stored strokes reload them directly; a pre-strokes note gets its image as a
// permanent backdrop layer and the new ink lands on top — nothing is view-only.
const legacyBg = ref(''); // a legacy note's image, persisted as its backdrop on save
async function continueWriting(n: Note): Promise<void> {
  ink.clear();
  legacyBg.value = '';
  const strokes = n.hasInk ? ((await loadNoteInk(n.id)) as TabletStroke[] | null) : null;
  if (strokes) ink.setStrokes(strokes);
  if (n.hasImgs) {
    const pics = (await loadNoteImages(n.id)) as TabletImage[] | null;
    if (pics?.length) ink.setImages(pics);
  }
  if (n.hasWidgets) {
    const wds = (await loadNoteWidgets(n.id)) as TabletWidget[] | null;
    if (wds?.length) ink.setWidgets(wds);
  }
  // Awaited, because the backdrop is a layer that decides how big the board is, and
  // the fit at the end of this has to be able to see it.
  // The backdrop is old ink, so it is recoloured on the way in and the file on disk
  // is left as it was written (see stores/inkColor.ts). legacyBg keeps the ORIGINAL,
  // because that is what gets stored, and it is recoloured again on every open.
  if (n.hasBg) {
    const bg = await loadNoteBg(n.id);
    if (bg) await ink.setBackdrop(await inkedBackdrop(bg));
  } else if (!strokes) {
    const img = openImage.value || (await loadNoteImage(n.id));
    if (!img) return;
    await ink.setBackdrop(await inkedBackdrop(img));
    legacyBg.value = img; // becomes the note's permanent backdrop on save
  }
  editingNote.value = n;
  inkFolder.value = n.folderId;
  // What is on the board is what is on disk, and the note's picture was taken when
  // it was last saved, so neither needs writing again until something changes.
  markInkSaved();
  inkShotAt = Date.now();
  open.value = null;
  openImage.value = '';
  inkOpen.value = true;
  // Frame the whole note, now that every layer of it is loaded. The canvas mounts a
  // moment from now, and useTablet holds the fit until it has a size to fit against;
  // without that the view fell back to the home page and a note written further out on
  // the board opened on empty paper with no sign of which way its writing lay.
  ink.resetView();
  // The page and its stored transcript agree at this moment, so the question window
  // can use that text until the pen changes something.
  pageText.value = n.text;
  pageRev.value = ink.state.rev;
}

function closeInk(): void {
  // The draft stays on the canvas, and now on disk too: closing is pausing.
  stopHold(); // a key still down when the editor goes away has nothing left to undo
  void flushInk();
  inkOpen.value = false;
  askOpen.value = false;
}

// ---- the question window: for what you are unsure about mid-page ----
//
// It floats over the board so the page never goes away to make room for it, and it
// answers the question and stops: no hints, no next steps, nothing about the rest of
// the page (see NOTE_ASK_SYSTEM in ask.ts). The work stays the student's.
//
// What it costs is decided here. The page reaches the model as TEXT, and text of this
// page already exists: the note's own transcript, from the last time it was read. So
// pageText/pageRev hold that text and the board revision it belongs to, and the board
// is re-read only when the pen has moved on from it since. Ask five questions about a
// page you are not currently writing on and it is five small text calls and no reading
// at all; write a paragraph and ask again and it is one reading, reused by every
// question after it.

const askOpen = ref(false);
const askDraft = ref('');
const askThreadRef = ref<HTMLDivElement | null>(null);

// What the page says, and the board revision that text was read at. -1 means nothing
// has been read yet, so the first question reads. Both are refs because the line in
// the window's header states this, and a state nobody can see is a state nobody trusts.
const pageText = ref('');
const pageRev = ref(-1);

/** One thread per note. A board with no note behind it yet writes under DRAFT_KEY. */
const askKey = computed(() => editingNote.value?.id ?? DRAFT_KEY);
const askMessages = computed(() => thread(askKey.value));

// The autosave turns a nameless board into a real note partway through writing it. The
// questions asked before that happened belong to it.
watch(
  () => editingNote.value?.id,
  (id, was) => {
    if (id && !was) adoptThread(DRAFT_KEY, id);
  },
);

const askTitle = computed(() => {
  const n = editingNote.value;
  return n?.title ? `Question about "${n.title}"` : 'Question about this page';
});

/** Where the answers stand: what the model can see of the page, and how fresh it is. */
const askContextNote = computed(() => {
  if (noteAskStore.reading) return 'reading the page…';
  if (!pageText.value && !ink.state.hasInk) return 'nothing written yet';
  if (ink.state.rev !== pageRev.value) return 'page changed; the next question reads it';
  return pageText.value ? 'the page has been read' : 'nothing read yet';
});

function scrollAsk(): void {
  void nextTick(() => {
    const el = askThreadRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function toggleAsk(): void {
  askOpen.value = !askOpen.value;
  if (askOpen.value) {
    noteAskStore.failed = false; // a failure from an hour ago is not news now
    scrollAsk();
  }
}

/** Read the board, but only when what we hold no longer describes it. */
async function refreshPageText(): Promise<void> {
  if (ink.state.rev === pageRev.value) return;
  if (!ink.state.hasInk) {
    pageRev.value = ink.state.rev; // an empty board is read correctly by not reading it
    return;
  }
  noteAskStore.reading = true;
  try {
    const rev = ink.state.rev;
    // The newest few regions, not the whole term: see transcribeStrokes.
    const text = await transcribeStrokes(ink.getStrokes(), 4);
    if (text) {
      pageText.value = text;
      pageRev.value = rev;
    }
  } finally {
    noteAskStore.reading = false;
  }
}

async function onAsk(): Promise<void> {
  const q = askDraft.value.trim();
  if (!q || noteAskStore.busy) return;
  noteAskStore.busy = true;
  noteAskStore.failed = false;
  askDraft.value = '';
  scrollAsk();
  try {
    await refreshPageText();
    const n = editingNote.value;
    const ok = await askNote(askKey.value, q, {
      title: n?.title ?? '',
      path: folderPath(inkFolder.value),
      text: pageText.value,
      context: n?.context ?? '',
      folders: folderContextChain(inkFolder.value),
    });
    // The question stays in the thread; the draft comes back for a one-key retry.
    if (!ok) askDraft.value = q;
  } finally {
    noteAskStore.busy = false;
    scrollAsk();
  }
}

watch(askMessages, scrollAsk);

// ---- autosave: the writing reaches disk before the note is finished ----
//
// The board used to live in memory until Save was pressed, so leaving the Notebook
// tab (which unmounts this view) threw a page of handwriting away, and so did a
// reload. Now it writes itself a moment after the pen stops: the first thing on an
// empty board becomes a real note, marked a draft, and everything after that updates
// that note in place.
//
// Nothing on this path calls a model. Reading the page back into text is what the
// Save button does, and it stays a deliberate press.
const INK_AUTOSAVE_MS = 1200;
// How often the saved PICTURE of the board is refreshed while writing continues. The
// strokes ARE the note and cost a few kilobytes of JSON; the picture is a full canvas
// render plus a JPEG encode, which is not worth repeating every time the pen pauses.
// Leaving the editor always takes a fresh one, which is when it is looked at.
const INK_SHOT_MS = 20000;
// A hand that keeps moving would keep pushing the debounce out in front of itself, so
// a change that has been waiting this long is written whatever the pen is doing.
const INK_MAX_WAIT_MS = 15000;

let inkTimer: number | undefined;
let inkChain: Promise<void> = Promise.resolve();
let inkShotAt = 0;
let inkDirtySince = 0;
const inkSavedRev = ref(0);
const inkSavedAt = ref(0);
const inkDirty = computed(
  () =>
    ink.state.rev !== inkSavedRev.value &&
    (ink.state.hasInk || ink.state.hasImages || Boolean(editingNote.value)),
);

function cancelInkAutosave(): void {
  if (inkTimer) window.clearTimeout(inkTimer);
  inkTimer = undefined;
}

/** Declare the board and the disk to be in step, with nothing outstanding. */
function markInkSaved(): void {
  cancelInkAutosave();
  inkDirtySince = 0;
  inkSavedRev.value = ink.state.rev;
}

async function writeInk(full: boolean): Promise<void> {
  const rev = ink.state.rev;
  const note = editingNote.value;
  if (rev === inkSavedRev.value) return;
  // An empty board is not a note. (An existing one still saves: erasing a page is a
  // change like any other.)
  if (!note && !ink.state.hasInk && !ink.state.hasImages && !ink.state.hasWidgets) return;
  const strokes = ink.getStrokes();
  const images = ink.getImages();
  const boardWidgets = ink.getWidgets();
  const now = Date.now();
  const shoot = full || !note || now - inkShotAt > INK_SHOT_MS;
  const image = shoot ? ink.exportImage('all') : '';
  const thumb = image ? await makeThumb(image) : '';
  if (image) inkShotAt = now;
  if (note) {
    if (note.folderId !== inkFolder.value) updateNote(note.id, { folderId: inkFolder.value });
    await saveInkProgress(note.id, {
      image,
      thumb,
      strokes,
      images,
      widgets: boardWidgets,
      bg: legacyBg.value || undefined,
    });
  } else {
    if (!image) return; // the first save is what gives the note its picture
    const n = await saveNoteFromPad(
      { image, thumb, strokes, images, widgets: boardWidgets, draft: true },
      inkFolder.value,
    );
    // From here the draft IS the note: later autosaves and the Save button both write
    // to it instead of making a second one.
    editingNote.value = n;
  }
  inkSavedRev.value = rev;
  inkDirtySince = 0;
  inkSavedAt.value = Date.now();
}

/** One save at a time: two overlapping writes would race on the same blobs. */
function flushInk(full = true): Promise<void> {
  cancelInkAutosave();
  inkChain = inkChain
    .then(() => writeInk(full))
    .catch((err) => {
      console.warn('[nuclear-learning] ink autosave failed:', err);
    });
  return inkChain;
}

// Every change to the board (a stroke, an erase, an undo, a picture moved) resets the
// same short timer, so writing runs uninterrupted and the pause after it commits.
watch(
  () => ink.state.rev,
  () => {
    if (!inkOpen.value) return;
    cancelInkAutosave();
    if (!inkDirtySince) inkDirtySince = Date.now();
    if (Date.now() - inkDirtySince > INK_MAX_WAIT_MS) {
      void flushInk(false);
      return;
    }
    inkTimer = window.setTimeout(() => {
      inkTimer = undefined;
      void flushInk(false);
    }, INK_AUTOSAVE_MS);
  },
);

// A tab going into the background is the last moment anything is guaranteed to run,
// and it is also how this app is left: switch to something else mid-sentence.
function onHidden(): void {
  if (document.visibilityState !== 'hidden') return;
  if (inkOpen.value) void flushInk();
  if (autosaveTimer && open.value) saveOpen();
}

async function saveInk(): Promise<void> {
  if (inkSaving.value) return;
  stopHold();
  cancelInkAutosave(); // the commit below supersedes anything pending
  const img = ink.exportImage('all');
  if (!img) {
    closeInk();
    return;
  }
  inkSaving.value = true;
  try {
    await inkChain; // never rejects: an autosave still in flight finishes first
    const thumb = await makeThumb(img);
    const editing = editingNote.value;
    if (editing) {
      await updateNoteInk(editing.id, {
        image: img,
        thumb,
        strokes: ink.getStrokes(),
        images: ink.getImages(),
        widgets: ink.getWidgets(),
        bg: legacyBg.value || undefined,
      });
      if (editing.folderId !== inkFolder.value) updateNote(editing.id, { folderId: inkFolder.value });
      selected.value = inkFolder.value;
      editingNote.value = null;
      legacyBg.value = '';
    } else {
      const n = await saveNoteFromPad(
        {
          image: img,
          thumb,
          strokes: ink.getStrokes(),
          images: ink.getImages(),
          widgets: ink.getWidgets(),
        },
        inkFolder.value,
      );
      selected.value = n.folderId;
    }
    ink.clear();
    inkOpen.value = false;
    inkShotAt = 0;
    inkSavedAt.value = 0;
    markInkSaved();
  } catch (err) {
    console.warn('[nuclear-learning] ink note save failed:', err);
  } finally {
    inkSaving.value = false;
  }
}

function onWinResize(): void {
  if (inkOpen.value) ink.resize();
}

// ---- keyboard: Esc closes the top layer; ink keys while the editor is open ----

function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

// Hold-to-repeat undo/redo on the board, the same gate and the same accelerating
// cadence the math pad uses (holdRepeat owns both). Before it, a held Z here ran at
// whatever raw rate the keyboard happened to auto-repeat at, with no starting delay
// and no way to tune it, so clearing a board and nudging off one stroke were the same
// speed. The Cmd variant runs without the fallback timer for the same macOS reason as
// on the pad: the plain key's keyup is suppressed while Cmd is held.
let held: {
  key: string;
  action: () => void;
  started: number;
  last: number;
  timer: number;
} | null = null;

function fireHeld(): void {
  if (!held) return;
  const now = performance.now();
  if (!holdDue(held.started, held.last, now)) return;
  held.last = now;
  held.action();
}

function stopHold(): void {
  if (!held) return;
  if (held.timer) window.clearInterval(held.timer);
  held = null;
}

function startHold(key: string, action: () => void, withTimer: boolean): void {
  stopHold();
  held = { key, action, started: performance.now(), last: 0, timer: 0 };
  if (withTimer) held.timer = window.setInterval(fireHeld, 10);
}

/** One press removes exactly one; holding the key hands the rest to the ramp. */
function tapOrHold(e: KeyboardEvent, k: string, action: () => void): void {
  if (e.repeat) fireHeld();
  else {
    action();
    startHold(k, action, !e.metaKey);
  }
  e.preventDefault();
}

function onKeyUp(e: KeyboardEvent): void {
  if (!held) return;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (k === held.key || k === 'Meta' || k === 'Control' || k === 'Shift' || k === 'Alt') stopHold();
}

function onKeys(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    // Outside in: a held picture, then the question window, then the editor itself.
    if (inkOpen.value && ink.state.hasSelection) ink.clearSelection();
    else if (askOpen.value) askOpen.value = false;
    else if (inkOpen.value) closeInk();
    else if (open.value) closeOpen();
    else return;
    e.preventDefault();
    return;
  }
  if (!inkOpen.value || isEditableTarget(e.target)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey && k === 'z') {
    tapOrHold(e, k, e.shiftKey ? ink.redo : ink.undo);
    return;
  }
  if (mod && !e.altKey && k === 'y') {
    tapOrHold(e, k, ink.redo);
    return;
  }
  if (mod || e.altKey) return;
  if ((k === 'Delete' || k === 'Backspace') && ink.state.hasSelection) {
    ink.deleteSelectedImage();
    e.preventDefault();
    return;
  }
  switch (k) {
    case 'z':
      tapOrHold(e, k, ink.undo);
      break;
    case 'y':
      tapOrHold(e, k, ink.redo);
      break;
    case 'e':
      ink.toggleEraser();
      e.preventDefault();
      break;
    case 'h':
      ink.toggleHand();
      e.preventDefault();
      break;
    case '+':
    case '=':
      ink.zoomBy(1.25);
      e.preventDefault();
      break;
    case '-':
      ink.zoomBy(0.8);
      e.preventDefault();
      break;
    case '0':
      ink.resetView();
      e.preventDefault();
      break;
  }
}

onMounted(() => {
  window.addEventListener('resize', onWinResize);
  window.addEventListener('keydown', onKeys);
  window.addEventListener('keyup', onKeyUp);
  // A key released while the window is not focused is never seen, which would leave
  // the repeat timer running against a key nobody is holding.
  window.addEventListener('blur', stopHold);
  window.addEventListener('paste', onPaste);
  document.addEventListener('fullscreenchange', onFsChange);
  document.addEventListener('visibilitychange', onHidden);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWinResize);
  window.removeEventListener('keydown', onKeys);
  window.removeEventListener('keyup', onKeyUp);
  window.removeEventListener('blur', stopHold);
  window.removeEventListener('paste', onPaste);
  document.removeEventListener('fullscreenchange', onFsChange);
  document.removeEventListener('visibilitychange', onHidden);
  stopHold();
  // Leaving the notebook with a debounce in flight would drop the last keystrokes.
  if (autosaveTimer && open.value) saveOpen();
  cancelAutosave();
  // Switching to another tab unmounts this view, and the board goes with it. The
  // write below outlives the component: it holds its own copy of the strokes.
  void flushInk();
});

// ---- note detail ----

const open = ref<Note | null>(null);
const openImage = ref('');
const draftTitle = ref('');
const draftText = ref('');
const draftContext = ref('');
const draftTags = ref('');
const draftFolder = ref(INBOX_ID);
const busyExtract = ref(false);

// The dialog edits DRAFTS while the note underneath keeps living: a transcription
// that started minutes ago can land while the title is being typed. So every draft
// remembers the value it was opened with, and the two rules below follow from it.
// Without them, saving a renamed note wrote the whole snapshot back and a transcript
// that arrived in the meantime was overwritten with the empty field it replaced.
const baseline = ref({ title: '', text: '', context: '', tags: '', folderId: INBOX_ID });

function snapshot(n: Note): void {
  baseline.value = {
    title: n.title,
    text: n.text,
    context: n.context,
    tags: n.tags.join(', '),
    folderId: n.folderId,
  };
}

// A filed document is shown as itself: a picture as a picture, a PDF in the
// browser's own viewer, a Word file as the HTML the dev server converts it to. Text
// files need no viewer at all, since their content IS the transcript field.
const openDoc = ref<{ kind: DocKind; html: string } | null>(null);
const docBusy = ref(false);
const hasViewer = computed(() => openDoc.value?.kind === 'word' || openDoc.value?.kind === 'pdf');

// A note with nothing to show beside the text IS its text, so the writing box gets
// the whole window instead of ten rows in the corner of a two-column layout. That
// was the whole of "+ Text note": a tile with no editor behind it.
const isWriting = computed(() => Boolean(open.value) && !openImage.value && !hasViewer.value);

/**
 * The body field is called what it actually is. "Transcript / content (LLM-seeded)"
 * was on every note including the ones the user typed themselves, which told them
 * their own writing belonged to the model.
 */
const bodyLabel = computed(() => {
  const n = open.value;
  if (!n) return 'Note';
  if (n.hasImage) return 'Transcript, read from your handwriting';
  if (n.file) return 'Text from the document';
  return 'Note';
});

async function openNote(n: Note): Promise<void> {
  cancelAutosave();
  dirty.value = false;
  savedAt.value = 0;
  open.value = n;
  draftTitle.value = n.title;
  draftText.value = n.text;
  draftContext.value = n.context;
  draftTags.value = n.tags.join(', ');
  draftFolder.value = n.folderId;
  snapshot(n);
  openImage.value = '';
  openDoc.value = null;
  const kind = n.file ? docKind(n.file) : null;
  if (kind && kind !== 'image') {
    openDoc.value = { kind, html: '' };
    if (kind === 'word') {
      docBusy.value = true;
      const view = await loadDocxView(n.id);
      // The dialog may have moved on while the conversion ran.
      if (open.value?.id === n.id) openDoc.value = { kind, html: view?.html ?? '' };
      docBusy.value = false;
    }
  }
  if (n.hasImage) openImage.value = await loadNoteImage(n.id);
}

// Rule one: a transcript landing while the dialog is open fills the fields nobody
// has touched, so the writing appears under the cursor instead of waiting for a
// reopen. A field being edited is left exactly as typed.
watch(
  () => {
    const n = open.value;
    return n ? { title: n.title, text: n.text, tags: n.tags.join(', ') } : null;
  },
  (now) => {
    if (!now) return;
    const base = baseline.value;
    if (now.title !== base.title && draftTitle.value === base.title) draftTitle.value = now.title;
    if (now.text !== base.text && draftText.value === base.text) draftText.value = now.text;
    if (now.tags !== base.tags && draftTags.value === base.tags) draftTags.value = now.tags;
    base.title = now.title;
    base.text = now.text;
    base.tags = now.tags;
  },
);

// Rule two: Save writes back only what this dialog actually changed. An untouched
// field is never sent, so whatever the note has now (a fresh transcript, tags from
// the background call) survives a save that was only about the title.
function saveOpen(): void {
  const n = open.value;
  if (!n) return;
  const base = baseline.value;
  const patch: Parameters<typeof updateNote>[1] = {};
  const title = draftTitle.value.trim();
  if (title !== base.title) patch.title = title;
  if (draftText.value !== base.text) patch.text = draftText.value;
  if (draftContext.value !== base.context) patch.context = draftContext.value;
  if (draftTags.value !== base.tags) {
    patch.tags = draftTags.value.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (draftFolder.value !== base.folderId) patch.folderId = draftFolder.value;
  if (Object.keys(patch).length) updateNote(n.id, patch);
  snapshot(n);
}

/**
 * Autosave. Typing commits itself a moment after it stops, so a note is never one
 * stray click away from being lost and Save stops being a thing to remember.
 *
 * It goes through saveOpen, which means it inherits the patch-only rule: an
 * untouched field is never written back. And the only store call on this path is
 * updateNote, which writes to disk and nothing else. No transcription, no model
 * call, no cost. Re-reading the handwriting stays a deliberate button press.
 */
const AUTOSAVE_MS = 700;
let autosaveTimer: number | undefined;
const savedAt = ref(0);
const dirty = ref(false);

function cancelAutosave(): void {
  if (autosaveTimer) window.clearTimeout(autosaveTimer);
  autosaveTimer = undefined;
}

function scheduleAutosave(): void {
  cancelAutosave();
  dirty.value = true;
  autosaveTimer = window.setTimeout(() => {
    autosaveTimer = undefined;
    if (!open.value) return;
    saveOpen();
    dirty.value = false;
    savedAt.value = Date.now();
  }, AUTOSAVE_MS);
}

// A transcript landing mid-edit fills untouched drafts and moves the baseline with
// them, so that path leaves nothing for saveOpen to patch and costs a no-op write.
watch([draftTitle, draftText, draftContext, draftTags, draftFolder], () => {
  if (open.value) scheduleAutosave();
});

function closeOpen(): void {
  // Closing saves: notes apps autosave, and losing an edited transcript to a stray
  // click would break the trust the transcript exists for.
  cancelAutosave();
  saveOpen();
  dirty.value = false;
  open.value = null;
  openImage.value = '';
  openDoc.value = null;
}

/**
 * Enter commits the note and puts the dialog away. From the one-line fields (title,
 * tags) it is the bare key, the way renaming works everywhere else; from the
 * transcript and context boxes it takes Cmd/Ctrl, so plain Enter stays a new line.
 */
function onDialogKey(e: KeyboardEvent): void {
  if (e.key !== 'Enter' || e.isComposing) return;
  const oneLine = e.target instanceof HTMLInputElement && e.target.type !== 'checkbox';
  if (!oneLine && !(e.metaKey || e.ctrlKey)) return;
  e.preventDefault();
  closeOpen();
}

function onDeleteNote(): void {
  const n = open.value;
  if (!n) return;
  cancelAutosave(); // a pending save must not resurrect what was just deleted
  void deleteNote(n.id);
  open.value = null;
}

/** "Transcribing…" while a page is read, "Transcribing 3/12…" while a board is read
 *  region by region, so a two-minute read visibly moves. */
function readingLabel(id: string): string {
  const at = notesStore.reading[id];
  return at ? `Transcribing ${at}…` : 'Transcribing…';
}

async function onReExtract(): Promise<void> {
  const n = open.value;
  if (!n || busyExtract.value) return;
  busyExtract.value = true;
  try {
    await reExtractNote(n.id);
    // Asking for a re-transcribe is asking for the machine's version, so those two
    // drafts follow the note again however they were edited. The title is not among
    // them: it is never re-transcribed, and resyncing it would throw away a rename
    // that has not been saved yet.
    draftText.value = n.text;
    draftTags.value = n.tags.join(', ');
    baseline.value.text = n.text;
    baseline.value.tags = n.tags.join(', ');
  } finally {
    busyExtract.value = false;
  }
}

/**
 * Name the note from what is on it. The transcription already read the page and left
 * its candidate behind, so this is usually instant and free; a note that has no
 * candidate is named from its text with one small call (see suggestTitle).
 *
 * It goes into the draft field, which means it is a proposal like anything else typed
 * there: keep it, edit it, or type over it.
 */
const titleBusy = ref(false);

async function onSuggestTitle(): Promise<void> {
  const n = open.value;
  if (!n || titleBusy.value) return;
  titleBusy.value = true;
  try {
    const t = await suggestTitle(n.id);
    if (t) draftTitle.value = t;
  } finally {
    titleBusy.value = false;
  }
}

function onNewTypedNote(): void {
  const n = addTypedNote(selected.value || INBOX_ID);
  void openNote(n);
}

function togglePin(n: Note, e: Event): void {
  e.stopPropagation();
  updateNote(n.id, { pinned: !n.pinned });
}

/**
 * Delete straight from the grid. Before this the only Delete lived in the note
 * dialog's footer, and with a document open that footer sat under a 72vh viewer,
 * so removing a filed Word file meant opening it and scrolling past the whole
 * document to find the button.
 */
function deleteFromCard(n: Note): void {
  void deleteNote(n.id);
  if (open.value?.id === n.id) open.value = null;
}

function excerpt(n: Note): string {
  return n.text.length > 180 ? `${n.text.slice(0, 180)}…` : n.text;
}

/** What an unnamed note is called on its card. A draft says so rather than claiming
 *  to be transcribing: nothing is reading it until it is finished. */
function cardTitle(n: Note): string {
  if (n.draft) return 'Draft';
  return n.hasImage && !n.extracted ? 'Transcribing…' : 'Untitled';
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function fmtClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
}
</script>

<template>
  <section class="notes-layout">
    <aside class="ntree" :style="{ width: `${treeW}px` }">
      <button class="ntree-row" :class="{ active: selected === '' }" @click="selected = ''">
        <span class="twist leaf" />
        <span class="ntree-name">All notes</span>
        <span class="ntree-count mono">{{ notesStore.notes.length }}</span>
      </button>
      <div
        v-for="t in visibleTree"
        :key="t.folder.id"
        class="ntree-item"
        :class="{ sel: selected === t.folder.id, drop: dropTarget === t.folder.id }"
        @dragover="onFolderDragOver(t.folder.id, $event)"
        @dragleave="dropTarget = ''"
        @drop="onFolderDrop(t.folder.id, $event)"
      >
        <!-- Renaming happens in the row itself. -->
        <div
          v-if="renamingId === t.folder.id"
          class="ntree-edit"
          :style="{ paddingLeft: `${0.2 + t.depth * 0.85}rem` }"
        >
          <input
            v-model="renameDraft"
            v-focus
            class="tree-input"
            aria-label="Folder name"
            @keydown.enter="commitRename"
            @keydown.esc="renamingId = ''"
            @blur="commitRename"
          />
        </div>
        <button
          v-else
          class="ntree-row"
          :class="{ active: selected === t.folder.id }"
          :style="{ paddingLeft: `${0.2 + t.depth * 0.85}rem` }"
          :title="folderPath(t.folder.id)"
          @click="selected = t.folder.id"
        >
          <span
            class="twist"
            :class="{ leaf: !t.kids, open: t.kids && !collapsed.has(t.folder.id) }"
            :title="t.kids ? 'Show or hide the subfolders' : ''"
            @click.stop="t.kids && toggleFolder(t.folder.id)"
            >▸</span
          >
          <span class="ntree-name">{{ t.folder.name }}</span>
          <span v-if="t.folder.context" class="ctx-dot" title="This folder carries context for chats">●</span>
          <span class="ntree-count mono">{{ countIn(t.folder.id) }}</span>
        </button>
        <!-- Named actions for the folder you have selected. They used to be a
             hover-only +, ✎ and × with the meaning hidden in a tooltip. -->
        <span v-if="selected === t.folder.id && renamingId !== t.folder.id" class="ntree-acts">
          <button @click="startNewFolder(t.folder.id)">New subfolder</button>
          <button v-if="t.folder.id !== INBOX_ID" @click="startRename(t.folder)">Rename</button>
          <ConfirmButton
            v-if="t.folder.id !== INBOX_ID"
            label="Delete"
            confirm-label="Delete it"
            title="The notes and subfolders inside move one level up; nothing is lost"
            @confirm="onDeleteFolder(t.folder.id)"
          />
        </span>
        <!-- A new subfolder is named where it will live. -->
        <div
          v-if="newFolderParent === t.folder.id"
          class="ntree-edit"
          :style="{ paddingLeft: `${1.05 + t.depth * 0.85}rem` }"
        >
          <input
            v-model="newFolderName"
            v-focus
            class="tree-input"
            placeholder="Subfolder name"
            aria-label="New subfolder name"
            @keydown.enter="commitNewFolder"
            @keydown.esc="cancelNewFolder"
            @blur="commitNewFolder"
          />
        </div>
      </div>
      <div v-if="newFolderParent === null" class="ntree-edit">
        <input
          v-model="newFolderName"
          v-focus
          class="tree-input"
          placeholder="Folder name"
          aria-label="New folder name"
          @keydown.enter="commitNewFolder"
          @keydown.esc="cancelNewFolder"
          @blur="commitNewFolder"
        />
      </div>
      <button class="ghost newfolder" @click="startNewFolder(null)">+ Folder</button>
      <p class="tree-hint">Drop files or drag a note onto a folder to file it there.</p>
    </aside>

    <div
      class="vsplit"
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize the folder tree; double-click resets"
      @pointerdown="startTreeDrag"
      @dblclick="resetTreeW"
    />

    <div
      class="nmain scroll"
      :class="{ dropping: dropDepth > 0 }"
      @dragenter="onPaneDragEnter"
      @dragover="onPaneDragOver"
      @dragleave="onPaneDragLeave"
      @drop="onPaneDrop"
    >
      <div class="page-head">
        <h2>{{ selected ? folderPath(selected) : 'Notes' }}</h2>
        <span class="count mono">{{ results.length }}</span>
        <span class="spacer" />
        <button class="ghost" title="Write a note with the pen, right here" @click="openInk">+ Ink note</button>
        <button class="ghost" @click="onNewTypedNote">+ Text note</button>
        <button
          class="ghost"
          title="File a Word document, PDF, or text file into this folder (dropping it works too)"
          @click="pickFiles"
        >
          + File
        </button>
        <input ref="fileInputRef" class="hidden-file" type="file" multiple @change="onFilePicked" />
      </div>

      <input
        v-model="query"
        class="search"
        type="search"
        placeholder="Search notes: title, tag, content…"
        aria-label="Search notes"
      />

      <!-- The folder's own background. A note's context says what that page is;
           this says what the subject is, and it is inherited by everything filed
           below here. -->
      <details v-if="selected" class="folder-ctx" :open="ctxOpen" @toggle="ctxOpen = ($event.target as HTMLDetailsElement).open">
        <summary>
          What "{{ folderById(selected)?.name }}" is about
          <span class="ctx-sub">
            {{ folderCtxDraft.trim() ? 'Rides into every chat that draws on anything filed here' : 'Empty' }}
          </span>
        </summary>
        <textarea
          v-model="folderCtxDraft"
          rows="4"
          class="text-edit ctx-edit"
          placeholder="What the module is, how it is examined, what past papers looked like, what the lecturer keeps asking. Everything filed in here and below inherits it."
          @input="onFolderCtxInput"
        />
      </details>

      <p v-if="dropDepth > 0" class="dropbar mono">
        Drop into {{ selected ? folderPath(selected) : 'Inbox' }}, or onto any folder on the left
      </p>
      <p v-if="fileBusy" class="filing mono">Filing {{ fileBusy }} document{{ fileBusy === 1 ? '' : 's' }}…</p>
      <p v-if="fileError" class="filing err" @click="fileError = ''">{{ fileError }} (click to dismiss)</p>

      <div v-if="notesStore.notes.length === 0" class="empty">
        No notes yet. "+ Ink note" opens a pen page right here; the Note button on the
        math pad captures a solving page; "+ Text note" types one. Documents you
        already have (Word, PDF, text) are dropped straight into a folder or picked
        with "+ File". Every ink note is transcribed to searchable text in the
        background, and a Word file brings its own. Organize whenever you feel like it.
      </div>
      <div v-else-if="results.length === 0" class="empty">No match here. Try another word or the All notes view.</div>

      <div class="ngrid">
        <!-- A div, not a button: the card carries real buttons of its own now, and
             a button inside a button is not valid markup and does not click. -->
        <div
          v-for="n in results"
          :key="n.id"
          class="ncard"
          role="button"
          tabindex="0"
          draggable="true"
          @click="openNote(n)"
          @keydown.enter="openNote(n)"
          @keydown.space.prevent="openNote(n)"
          @dragstart="onNoteDragStart(n, $event)"
          @dragend="dragNote = ''"
        >
          <img v-if="n.thumb" :src="n.thumb" alt="" class="nthumb" />
          <span v-else-if="n.file" class="ndoc mono">{{ fileTag(n) }}</span>
          <!-- Named actions on hover. A card used to carry a single bare ★ and no way
               to delete at all, which sent every removal through the note dialog. -->
          <span class="ncard-acts">
            <button
              type="button"
              class="ncard-act"
              :title="n.pinned ? 'Stop keeping this at the top' : 'Keep this at the top of the list'"
              @click.stop="togglePin(n, $event)"
            >
              {{ n.pinned ? 'Unpin' : 'Pin' }}
            </button>
            <ConfirmButton
              label="Delete"
              confirm-label="Delete it"
              :title="`Delete ${n.title || 'this note'}`"
              @confirm="deleteFromCard(n)"
            />
          </span>
          <span class="ncard-body">
            <span class="ntitle-row">
              <span class="ntitle">{{ n.title || cardTitle(n) }}</span>
              <span v-if="n.pinned" class="pinned-flag" title="Pinned to the top">Pinned</span>
            </span>
            <span v-if="!n.thumb && n.text" class="nexcerpt">{{ excerpt(n) }}</span>
            <span class="nmeta mono">
              {{ fmtDate(n.ts) }} · {{ folderPath(n.folderId) }}
              <span v-if="n.draft" class="npending" title="Saved as you wrote it. Open it, continue writing, and Save reads it into text.">
                · draft</span
              >
              <span v-else-if="n.hasImage && !n.extracted" class="npending">
                · transcribing<template v-if="notesStore.reading[n.id]"> {{ notesStore.reading[n.id] }}</template>…
              </span>
            </span>
            <span v-if="n.tags.length" class="ntags">
              <span v-for="t in n.tags" :key="t" class="tag">{{ t }}</span>
            </span>
          </span>
        </div>
      </div>
    </div>

    <!-- The ink editor: a full writing surface over the notebook — never a popup.
         It owns the whole pane while open; Esc or Close pauses the draft. -->
    <div v-if="inkOpen" class="ink-full">
      <div class="ink-head">
        <span class="ink-title">{{ editingNote ? `Continue: ${editingNote.title || 'Untitled'}` : 'Ink note' }}</span>
        <label class="ink-folder mono">
          into
          <select v-model="inkFolder">
            <option v-for="t in tree" :key="t.folder.id" :value="t.folder.id">
              {{ ' '.repeat(t.depth * 2) + t.folder.name }}
            </option>
          </select>
        </label>
        <span class="spacer" />
        <!-- The writing is on disk either way; this line says so, and says when. -->
        <span class="ink-saved mono" role="status">
          <template v-if="inkDirty">Saving…</template>
          <template v-else-if="inkSavedAt">Saved {{ fmtClock(inkSavedAt) }}</template>
        </span>
        <button
          class="ghost"
          :class="{ on: askOpen }"
          title="Ask about something you are unsure of while writing. It answers the question and nothing more: no hints, no next steps. The page reaches it as text, and it is only re-read when you have written since."
          @click="toggleAsk"
        >
          Ask
        </button>
        <button
          :disabled="inkSaving || (!ink.state.hasInk && !ink.state.hasImages && !ink.state.hasWidgets)"
          title="Finish the note and read the handwriting back into text. The writing itself is already saved."
          @click="saveInk"
        >
          {{ inkSaving ? 'Saving…' : 'Save note' }}
        </button>
        <button class="ghost" title="Back to the notebook; the draft is saved (Esc)" @click="closeInk">Close</button>
      </div>
      <div ref="inkWrapRef" class="inkwrap">
        <canvas
          ref="inkCanvasRef"
          class="inkpad"
          :class="{
            erasing: ink.state.tool === 'eraser',
            grabbing: ink.state.tool === 'hand',
          }"
          aria-label="Note writing area"
        />
        <!-- Widgets sit above the ink and are placed by the same transform the canvas
             draws with. The layer lets everything through; only the widgets in it
             catch the pointer, so the board around them is still writing surface. -->
        <div v-if="boardXform" class="widgetlayer">
          <BoardWidget
            v-for="w in widgets"
            :key="w.id"
            :widget="w"
            :k="boardXform.k"
            :ox="boardXform.ox"
            :oy="boardXform.oy"
            @update="onWidgetUpdate(w.id, $event)"
            @remove="removeWidget(w.id)"
            @edit="openWidgetCode(w.id)"
          />
        </div>
        <div class="tooldock" role="toolbar" aria-label="Ink tools">
          <button :disabled="!ink.state.canUndo" title="Undo stroke (Z; hold to remove several)" @click="ink.undo()">Undo</button>
          <button :disabled="!ink.state.canRedo" title="Redo (Y)" @click="ink.redo()">Redo</button>
          <button
            :class="{ on: ink.state.tool === 'eraser' }"
            title="Stroke eraser (E). Holding the pen's lower button erases too, and lets go of it again."
            @click="ink.toggleEraser()"
          >
            Eraser
          </button>
          <button
            :class="{ on: ink.state.tool === 'hand' }"
            title="Move the board with the pen (H); holding space does the same while writing, as does dragging with the middle mouse button or scrolling"
            @click="ink.toggleHand()"
          >
            Hand
          </button>
          <button
            v-if="ink.state.hasSelection"
            title="Pin it to the page: the pen writes straight over it and can no longer nudge, resize or turn it"
            @click="ink.lockSelectedImage()"
          >
            Lock picture
          </button>
          <button
            v-else-if="ink.state.lockedImages"
            title="Hand the pinned pictures back, so they can be picked up and moved again"
            @click="ink.unlockImages()"
          >
            Unlock {{ ink.state.lockedImages }} picture{{ ink.state.lockedImages === 1 ? '' : 's' }}
          </button>
          <button
            v-if="ink.state.hasSelection"
            class="danger"
            title="Remove the selected picture (Delete)"
            @click="ink.deleteSelectedImage()"
          >
            Remove picture
          </button>
          <button
            title="Put a widget on the board: paste a JSX component and use it here, beside what you are writing about it. Drag its border to move it."
            @click="addWidget()"
          >
            + Widget
          </button>
          <span class="zoomlvl">{{ ink.state.zoomPct }}%</span>
          <button title="Zoom out (-): the board has no fixed size, so this keeps going" @click="ink.zoomBy(0.8)">−</button>
          <button title="Zoom in (+); ctrl+scroll zooms at the cursor" @click="ink.zoomBy(1.25)">+</button>
          <button title="Fit everything written (0)" @click="ink.resetView()">Fit</button>
          <button
            title="Fullscreen writing: the page fills the screen, so the tablet maps ~1:1 onto it (Esc leaves)"
            @click="toggleFullscreen"
          >
            Full
          </button>
        </div>
      </div>
    </div>

    <!-- A widget's source. It floats like the question window and for the same reason:
         the widget is on the board behind it, rebuilding as the code is typed, and
         watching that happen is the whole point of editing it here. -->
    <FloatWindow
      v-if="inkOpen && codingWidget"
      pane-key="notesWidgetCode"
      title="Widget code"
      :w="470"
      :h="440"
      :min-w="320"
      :min-h="220"
      @close="codingWidget = 0"
    >
      <textarea
        v-model="codeDraft"
        class="wcode mono"
        spellcheck="false"
        aria-label="Widget source"
      />
    </FloatWindow>

    <!-- The question window. It floats over the board rather than taking its place,
         so the page you are asking about is still in front of you while you ask. -->
    <FloatWindow
      v-if="inkOpen && askOpen"
      pane-key="notesAsk"
      :title="askTitle"
      :w="430"
      :h="520"
      :min-w="320"
      :min-h="260"
      @close="askOpen = false"
    >
      <template #actions>
        <span class="ask-ctx mono" :title="`What the answers can see of the page: ${askContextNote}`">{{
          askContextNote
        }}</span>
        <button
          v-if="askMessages.length"
          class="ask-clear"
          type="button"
          title="Empty this thread"
          @click="clearThread(askKey)"
        >
          Clear
        </button>
      </template>
      <div ref="askThreadRef" class="ask-thread">
        <p v-if="!askMessages.length" class="ask-intro">
          For the thing you are unsure about while writing: a word, a sign, whether a
          rule applies here. It answers that and stops, so nothing here does the page
          for you. Enter asks, Shift+Enter is a new line.
        </p>
        <div v-for="(m, i) in askMessages" :key="i" class="ask-msg" :class="m.role">
          <MathText v-if="m.role === 'assistant'" :text="m.text" rich />
          <template v-else>{{ m.text }}</template>
        </div>
        <p v-if="noteAskStore.reading" class="ask-state mono">Reading the page…</p>
        <p v-else-if="noteAskStore.busy" class="ask-state mono">Thinking…</p>
        <p v-if="noteAskStore.failed && !noteAskStore.busy" class="ask-state err mono">
          No answer came back. The question is back in the box.
        </p>
      </div>
      <form class="ask-composer" @submit.prevent="onAsk">
        <textarea
          v-model="askDraft"
          rows="2"
          placeholder="What are you unsure about?"
          aria-label="Question about this page"
          @keydown.enter.exact.prevent="onAsk"
        />
        <button type="submit" :disabled="noteAskStore.busy || !askDraft.trim()">Ask</button>
      </form>
    </FloatWindow>

    <!-- Note detail: the image beside its editable transcript. -->
    <div v-if="open" class="ovl" @click.self="closeOpen">
      <div
        ref="noteWinRef"
        class="ovl-card"
        :style="noteWinStyle"
        role="dialog"
        aria-modal="true"
        aria-label="Note"
        @keydown="onDialogKey"
      >
        <div class="ovl-head">
          <input v-model="draftTitle" class="title-edit" type="text" placeholder="Title" aria-label="Note title" />
          <!-- Naming a note is the one place where reading it back is worth a button.
               The transcription already read the page and left a name behind, so this
               usually spends nothing; it fills the field, and the field stays yours. -->
          <button
            class="ghost title-ai"
            :disabled="titleBusy"
            :title="
              open.titleHint
                ? `Use the title the transcription suggested: ${open.titleHint}`
                : 'Name this note from what is on it. Costs one small call for a note that has never been read.'
            "
            @click="onSuggestTitle"
          >
            {{ titleBusy ? 'Naming…' : 'Suggest title' }}
          </button>
          <button class="x" aria-label="Close" title="Close (saves)" @click="closeOpen">×</button>
        </div>
        <div class="ovl-body">
        <div class="detail-grid" :class="{ single: !openImage && !hasViewer }">
          <!-- The picture is the way back into the pen: clicking it reopens the note
               on the board rather than sitting there as a dead thumbnail. -->
          <button
            v-if="openImage"
            class="nimg-btn"
            title="Click to keep writing on this note"
            @click="continueWriting(open)"
          >
            <img :src="openImage" class="nimg" alt="Handwritten note" />
            <span class="nimg-hint">Click to keep writing</span>
          </button>
          <div v-else-if="openDoc?.kind === 'word'" class="docview">
            <p v-if="docBusy" class="docnote mono">Reading the document…</p>
            <div v-else-if="openDoc.html" class="docx" v-html="openDoc.html" />
            <p v-else class="docnote mono">
              This one could not be read here. Download it to open it in Word.
            </p>
          </div>
          <iframe
            v-else-if="openDoc?.kind === 'pdf' && open.file"
            class="pdfview"
            :src="noteFileUrl(open)"
            :title="open.file.name"
          />
          <div class="detail-fields" :class="{ writing: isWriting }">
            <p v-if="open.file" class="filemeta mono">
              <span class="chip">{{ fileTag(open) }}</span>
              <span class="fname" :title="open.file.name">{{ open.file.name }}</span>
              <a
                v-if="openDoc?.kind === 'word'"
                :href="noteWordUrl(open)"
                title="Hand this file to Word itself. Word must be installed; the browser cannot open a .docx, which is why plain Open only ever downloaded it."
                >Open in Word</a
              >
              <a v-else :href="noteFileUrl(open)" target="_blank" rel="noopener">Open</a>
              <a :href="noteFileUrl(open, true)">Download</a>
            </p>
            <label class="f-label ctx-label">Your context, never written by the model
              <textarea
                v-model="draftContext"
                rows="3"
                class="text-edit ctx-edit"
                placeholder="Dump anything: the assignment this belongs to, where it came from, what it is for. Rides into every chat this note is attached to."
              />
            </label>
            <label class="f-label body-field">{{ bodyLabel }}
              <textarea
                v-model="draftText"
                rows="10"
                class="text-edit body-edit"
                :placeholder="isWriting ? 'Start writing. It saves itself.' : ''"
              />
            </label>
            <div class="field-row">
              <label class="f-label">Tags, comma separated
                <input v-model="draftTags" type="text" />
              </label>
              <label class="f-label">Folder
                <select v-model="draftFolder">
                  <option v-for="t in tree" :key="t.folder.id" :value="t.folder.id">
                    {{ ' '.repeat(t.depth * 2) + t.folder.name }}
                  </option>
                </select>
              </label>
            </div>
            <details v-if="draftText" class="preview">
              <summary>Show it rendered, with the maths typeset</summary>
              <div class="preview-body"><MathText :text="draftText" /></div>
            </details>
          </div>
        </div>
        </div>
        <div class="ovl-actions">
          <button
            title="Close this note. Everything is already saved (Enter in a one-line field, or Cmd/Ctrl+Enter anywhere)"
            @click="closeOpen"
          >
            Done
          </button>
          <span class="savestate mono" aria-live="polite">
            {{ dirty ? 'Saving…' : savedAt ? 'Saved' : '' }}
          </span>
          <button
            v-if="open.hasImage"
            title="Reopen this note in the editor and keep writing; Save updates the note"
            @click="continueWriting(open)"
          >
            Continue writing
          </button>
          <button
            v-if="open.hasImage"
            :disabled="busyExtract"
            title="Transcribe the image again (overwrites the transcript and tags; your title stays)"
            @click="onReExtract"
          >
            {{ busyExtract ? readingLabel(open.id) : 'Re-transcribe' }}
          </button>
          <label class="toggle pin-toggle">
            <input
              :checked="open.pinned"
              type="checkbox"
              @change="updateNote(open.id, { pinned: !open.pinned })"
            />
            Pinned
          </label>
          <span class="spacer" />
          <ConfirmButton
            ghost
            label="Delete"
            confirm-label="Delete it"
            title="Delete this note and its picture"
            @confirm="onDeleteNote"
          />
        </div>
        <span
          class="win-grip"
          title="Drag to resize this window; double-click resets"
          @pointerdown="startWinDrag"
          @dblclick="resetWinSize"
        />
      </div>
    </div>
  </section>
</template>

<style scoped>
.notes-layout {
  display: flex;
  height: 100%;
  min-height: 0;
  position: relative; /* the ink editor fills this, edge to edge */
}

.ntree {
  width: 240px;
  flex: none;
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 0.7rem 0.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
}

.ntree-item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.ntree-row {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  border: 0;
  background: none;
  text-align: left;
  padding: 0.32rem 0.6rem;
  border-radius: var(--radius);
  font-size: 0.88rem;
  color: var(--ink);
  cursor: pointer;
}

/* "All notes" is a row inside the column itself, not inside a .ntree-item, so the
   flex:1 above would let it swallow every spare pixel and push the folders to the
   floor. It is a list entry like the rest. */
.ntree > .ntree-row {
  flex: 0 0 auto;
}

.ntree-row:hover {
  background: var(--bg);
}

.ntree-row.active {
  background: var(--bg);
  font-weight: 600;
}

.ntree-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ntree-count {
  font-size: 0.74rem;
  color: var(--muted);
}

.ntree-acts {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  padding: 0.2rem 0.2rem 0.4rem 1.55rem;
}

.ntree-acts button {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  border-radius: var(--radius);
  padding: 0.2rem 0.45rem;
  font-size: 0.78rem;
  cursor: pointer;
}

.ntree-acts button:hover {
  color: var(--ink);
  border-color: var(--muted);
}

.ntree-acts button.danger:hover {
  color: var(--bad);
  border-color: var(--bad);
}

.newfolder {
  margin-top: 0.6rem;
  align-self: flex-start;
}

/* The drag handle between tree and grid; the notebook lays out the user's way. */
.vsplit {
  flex: none;
  width: 6px;
  margin-left: -3px;
  cursor: col-resize;
  touch-action: none;
  border-radius: 2px;
}

.vsplit:hover {
  background: color-mix(in srgb, var(--border) 65%, transparent);
}

.nmain {
  flex: 1;
  min-width: 0;
}

.count {
  font-size: 0.82rem;
  color: var(--muted);
  margin-left: 0.8rem;
}

.search {
  width: 100%;
  font-size: 0.95rem;
  padding: 0.55rem 0.7rem;
  margin-bottom: 0.6rem;
}

.empty {
  color: var(--muted);
  font-size: 0.90rem;
  line-height: 1.6;
  padding: 1.2rem 0.2rem;
  max-width: 44rem;
}

.ngrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.7rem;
  margin-top: 0.6rem;
}

.ncard {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  text-align: left;
  padding: 0;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}

.ncard:hover {
  border-color: var(--muted);
}

.nthumb {
  width: 100%;
  height: 110px;
  object-fit: contain;
  object-position: left top;
  background: #fff;
  border-bottom: 1px solid var(--border);
  padding: 0.4rem;
}

.ncard-body {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.55rem 0.7rem 0.65rem;
}

.ntitle-row {
  display: flex;
  align-items: baseline;
  gap: 0.4rem;
}

.ntitle {
  flex: 1;
  min-width: 0;
  font-size: 0.92rem;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.35;
}

.pinned-flag {
  flex: none;
  font-family: var(--mono);
  font-size: 0.80rem;
  color: var(--gold);
  border: 1px solid var(--gold);
  border-radius: 999px;
  padding: 0.02rem 0.4rem;
}

/* Named card actions, revealed on hover. Keyboard users get them from the focus
   ring on the card itself, which is why they are also shown on :focus-within. */
.ncard-acts {
  position: absolute;
  top: 0.35rem;
  right: 0.35rem;
  z-index: 1;
  display: flex;
  gap: 0.25rem;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.ncard:hover .ncard-acts,
.ncard:focus-within .ncard-acts {
  opacity: 1;
}

.ncard-act,
.ncard-acts :deep(.confirm-btn) {
  font-family: var(--mono);
  font-size: 0.8rem;
  line-height: 1;
  color: var(--ink);
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.25rem 0.45rem;
  cursor: pointer;
}

.ncard-act:hover,
.ncard-acts :deep(.confirm-btn:hover) {
  border-color: var(--muted);
}

.ncard-acts :deep(.confirm-btn.armed) {
  color: var(--accent-ink);
  background: var(--bad);
  border-color: var(--bad);
}

/* Inline naming in the tree */
.ntree-edit {
  display: flex;
  padding: 0.1rem 0.2rem;
}

.tree-input {
  flex: 1;
  min-width: 0;
  font-size: 0.88rem;
  padding: 0.28rem 0.5rem;
}

/* A folder that carries context says so, so the framing behind an answer is never
   invisible. */
.ctx-dot {
  flex: none;
  font-size: 0.55rem;
  color: var(--gold);
  line-height: 1;
}

.folder-ctx {
  margin: 0 0 0.7rem;
  border: 1px solid var(--gold);
  border-radius: var(--radius);
  background: var(--panel);
}

.folder-ctx > summary {
  cursor: pointer;
  padding: 0.45rem 0.7rem;
  font-size: 0.85rem;
  color: var(--gold);
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}

.folder-ctx .ctx-sub {
  font-family: var(--mono);
  font-size: 0.74rem;
  color: var(--muted);
}

.folder-ctx textarea {
  display: block;
  width: calc(100% - 1.4rem);
  margin: 0 0.7rem 0.7rem;
}

.nexcerpt {
  font-size: 0.84rem;
  color: var(--muted);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-line;
}

.nmeta {
  font-size: 0.76rem;
  color: var(--muted);
}

.npending {
  color: var(--gold);
}

.ntags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}

.tag {
  font-size: 0.76rem;
  font-family: var(--mono);
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.08rem 0.45rem;
}

/* Overlays */
.ovl {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  padding: 1.2rem;
}

/* A frame, not a document. Head and footer are fixed and the middle scrolls, so
   the actions stay on screen whatever is open and however the window is dragged.
   Before this the whole card scrolled as one block, which put Delete under a
   72vh-tall document viewer and made resizing look like it did nothing. */
.ovl-card {
  position: relative;
  display: flex;
  flex-direction: column;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 14px 48px rgba(0, 0, 0, 0.25);
  width: min(1020px, 96vw);
  height: min(880px, 88vh);
  overflow: hidden;
}

.ovl-body {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  padding: 0 1.3rem;
}

/* Each column carries its own scrollbar, so a long document never pushes the
   fields beside it out of reach. */
.ovl-body > .detail-grid {
  flex: 1;
  min-height: 0;
}

.ovl-body > .detail-grid > * {
  min-height: 0;
  overflow-y: auto;
}

.ovl-head {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.8rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--ink);
  padding: 1rem 1.3rem 0.6rem;
}

.ovl-head .x {
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0.1rem 0.3rem;
  margin-left: auto;
}

.ovl-head .x:hover {
  color: var(--ink);
}

/* Corner grip of the note window, anchored to the frame itself rather than to the
   end of the content, so it is in the same place no matter what is scrolled. */
.win-grip {
  position: absolute;
  right: 3px;
  bottom: 3px;
  z-index: 2;
  display: block;
  width: 16px;
  height: 16px;
  cursor: nwse-resize;
  touch-action: none;
  opacity: 0.65;
  background: linear-gradient(
    135deg,
    transparent 0 46%,
    var(--muted) 46% 54%,
    transparent 54% 66%,
    var(--muted) 66% 74%,
    transparent 74%
  );
}

.win-grip:hover {
  opacity: 1;
}

/* The ink editor: the whole pane, not a dialog. */
.ink-full {
  position: absolute;
  inset: 0;
  z-index: 10;
  background: var(--bg);
  display: flex;
  flex-direction: column;
  padding: 0.8rem;
  gap: 0.6rem;
}

.ink-head {
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.ink-title {
  font-weight: 600;
}

/* The Ask button says whether its window is open, the way the tool buttons do. */
.ink-head .ghost.on {
  border-color: var(--gold);
  color: var(--gold);
}

.ink-folder {
  font-size: 0.79rem;
  color: var(--muted);
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
}

.inkwrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

/* The widget layer covers the canvas exactly and is otherwise not there: nothing in
   it takes the pointer except the widgets themselves. */
.widgetlayer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border-radius: var(--radius);
  pointer-events: none;
}

.wcode {
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: 0;
  padding: 0.6rem 0.7rem;
  font-size: 0.76rem;
  line-height: 1.55;
  tab-size: 2;
  white-space: pre;
  overflow-wrap: normal;
  resize: none;
}

.inkpad {
  width: 100%;
  height: 100%;
  display: block;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  touch-action: none;
  cursor: crosshair;
}

.inkpad.erasing {
  cursor: cell;
}

.inkpad.grabbing {
  cursor: grab;
}

/* Quiet by design: it is there to be believed, not read. */
.ink-saved {
  font-size: 0.72rem;
  color: var(--muted);
  min-width: 5.5rem;
  text-align: right;
}

.tooldock button.danger {
  border-color: var(--bad);
  color: var(--bad);
}

.tooldock {
  position: absolute;
  top: 0.6rem;
  left: 0.6rem;
  display: flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.3rem 0.4rem;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 3px 14px rgba(0, 0, 0, 0.08);
}

.tooldock button {
  font-size: 0.80rem;
  padding: 0.3rem 0.55rem;
}

.tooldock button.on {
  border-color: var(--gold);
  color: var(--gold);
}

.tooldock .zoomlvl {
  font-family: var(--mono);
  font-size: 0.78rem;
  color: var(--muted);
  min-width: 3ch;
  text-align: right;
  padding: 0 0.15rem;
  font-variant-numeric: tabular-nums;
}

/* The question window over the board */
.ask-ctx {
  font-size: 0.66rem;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12rem;
}

.ask-clear {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  border-radius: var(--radius);
  padding: 0.12rem 0.4rem;
  font-size: 0.72rem;
  cursor: pointer;
}

.ask-clear:hover {
  color: var(--ink);
  border-color: var(--muted);
}

.ask-thread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.7rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.ask-intro {
  margin: 0;
  font-size: 0.79rem;
  line-height: 1.55;
  color: var(--muted);
}

/**
 * The THREAD scrolls, never a message inside it. A message with an overflow of its own
 * is a scroll container, and a scroll container as a flex item may shrink to nothing,
 * so every answer was squeezed into a box the height of the window with its own
 * scrollbar and its formulas and tables cut off inside it. Wide things (tables, code,
 * display math) still scroll, one level further in, where MathText puts that overflow.
 */
.ask-msg {
  flex: none;
  min-width: 0;
  max-width: 100%;
  font-size: 0.86rem;
  line-height: 1.55;
  color: var(--ink);
}

/* Typed text keeps the line breaks it was typed with. The answer must NOT: it arrives
   as rendered blocks, and pre-wrap there turns the markup's own newlines into gaps. */
.ask-msg.user {
  align-self: flex-end;
  max-width: 92%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.35rem 0.55rem;
}

.ask-state {
  margin: 0;
  font-size: 0.72rem;
  color: var(--muted);
}

.ask-state.err {
  color: var(--bad);
}

.ask-composer {
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 0.45rem;
  padding: 0.5rem 0.55rem;
  border-top: 1px solid var(--border);
}

.ask-composer textarea {
  flex: 1;
  min-width: 0;
  font-size: 0.86rem;
  line-height: 1.45;
  resize: none;
  font-family: var(--sans);
}

.ask-composer button {
  flex: none;
}

/* Detail */
.title-edit {
  flex: 1;
  min-width: 0;
  font-size: 1rem;
  font-weight: 600;
}

.title-ai {
  flex: none;
  font-size: 0.76rem;
  padding: 0.28rem 0.6rem;
}

.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  /* One row exactly as tall as the frame, so the columns scroll instead of the
     dialog growing past the screen. */
  grid-template-rows: 100%;
  gap: 0.9rem;
}

.detail-grid.single {
  grid-template-columns: minmax(0, 1fr);
}

@media (max-width: 860px) {
  .detail-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* The picture is the door back to the pen. */
.nimg-btn {
  position: relative;
  display: block;
  padding: 0;
  border: 0;
  background: none;
  text-align: left;
  cursor: pointer;
}

.nimg {
  display: block;
  max-width: 100%;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.nimg-btn:hover .nimg {
  border-color: var(--gold);
}

.nimg-hint {
  position: absolute;
  left: 0.5rem;
  bottom: 0.6rem;
  font-family: var(--mono);
  font-size: 0.81rem;
  color: var(--accent-ink);
  background: color-mix(in srgb, var(--ink) 82%, transparent);
  border-radius: var(--radius);
  padding: 0.22rem 0.5rem;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.nimg-btn:hover .nimg-hint,
.nimg-btn:focus-visible .nimg-hint {
  opacity: 1;
}

.detail-fields {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
}

/* Field labels are sentences in the body font. They were 0.68rem uppercase mono,
   which reads as a machine tag rather than as a name for the box under it. */
.f-label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-family: var(--sans);
  font-size: 0.82rem;
  font-weight: 500;
  text-transform: none;
  letter-spacing: normal;
  color: var(--muted);
}

/* A note with no picture and no document beside it IS its text, so the box gets
   the whole window instead of ten rows in the corner. */
.detail-fields.writing {
  height: 100%;
  overflow: hidden;
}

.detail-fields.writing .body-field {
  flex: 1;
  min-height: 0;
}

.detail-fields.writing .body-edit {
  flex: 1;
  min-height: 10rem;
  resize: none;
  font-size: 0.98rem;
  line-height: 1.65;
}

.field-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 0.6rem;
  flex: none;
}

.savestate {
  font-size: 0.82rem;
  color: var(--muted);
  min-width: 4.5rem;
}

.text-edit {
  width: 100%;
  resize: vertical;
  font-size: 0.92rem;
  line-height: 1.5;
  font-family: var(--sans);
}

/* The student's own field stands apart from the machine-seeded ones. */
.ctx-label {
  color: var(--gold);
}

.ctx-edit {
  border-color: var(--gold);
}

/* Collapsed by default: it is a second copy of what is already in the box above,
   and open by default it doubled the length of every note. */
.preview {
  flex: none;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.preview > summary {
  cursor: pointer;
  padding: 0.45rem 0.7rem;
  font-size: 0.82rem;
  color: var(--muted);
}

.preview[open] > summary {
  border-bottom: 1px solid var(--border);
}

.preview-body {
  padding: 0.5rem 0.7rem;
  font-size: 0.92rem;
  line-height: 1.55;
  color: var(--ink);
  max-height: 14rem;
  overflow: auto;
  text-transform: none;
  letter-spacing: normal;
  font-family: var(--sans);
}

.ovl-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-wrap: wrap;
  padding: 0.75rem 1.3rem 0.85rem;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.pin-toggle {
  font-size: 0.85rem;
}

/* Folder tree: the twisty, the hover actions, and the drop highlight */
.twist {
  flex: none;
  width: 1.15rem;
  padding: 0.15rem 0; /* a real hit target, not a 6px glyph */
  text-align: center;
  font-size: 0.75rem;
  color: var(--muted);
  transition: transform 0.12s ease;
  cursor: pointer;
}

.twist:hover {
  color: var(--ink);
}

.twist.open {
  transform: rotate(90deg);
}

.twist.leaf {
  visibility: hidden;
  cursor: default;
}

.ntree-item.drop {
  outline: 2px dashed var(--gold);
  outline-offset: -2px;
  border-radius: var(--radius);
}

.tree-hint {
  margin-top: auto;
  padding: 0.6rem 0.3rem 0.2rem;
  font-size: 0.76rem;
  line-height: 1.5;
  color: var(--muted);
}

/* Filing documents */
.hidden-file {
  display: none;
}

.nmain.dropping {
  outline: 2px dashed var(--gold);
  outline-offset: -6px;
  border-radius: var(--radius);
}

.dropbar {
  position: sticky;
  top: 0;
  z-index: 2;
  margin: 0 0 0.5rem;
  padding: 0.45rem 0.7rem;
  font-size: 0.79rem;
  color: var(--gold);
  border: 1px dashed var(--gold);
  border-radius: var(--radius);
  background: var(--panel);
}

.filing {
  margin: 0 0 0.5rem;
  font-size: 0.80rem;
  color: var(--muted);
}

.filing.err {
  color: var(--gold);
  cursor: pointer;
}

/* A filed document has no thumbnail, so the card says what it is instead. */
.ndoc {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 110px;
  font-size: 0.79rem;
  letter-spacing: 0.06em;
  color: var(--muted);
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}

.filemeta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
  font-size: 0.78rem;
  color: var(--muted);
  min-width: 0;
}

.filemeta .chip {
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.05rem 0.45rem;
  flex: none;
}

.filemeta .fname {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.filemeta a {
  flex: none;
  color: var(--gold);
}

/* Document viewers: a Word file converted by the dev server, a PDF by the browser.
   Both sit on paper white in either theme, like the handwriting images do. */
.docview,
.pdfview {
  width: 100%;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

/* The column itself scrolls now (see .ovl-body), so the viewer no longer needs a
   viewport-relative cap and a scrollbar of its own inside another one. */
.docview {
  padding: 0.9rem 1.1rem;
  color: #1a1a1a;
  font-size: 0.9rem;
  line-height: 1.65;
}

.pdfview {
  height: 100%;
  min-height: 24rem;
  display: block;
}

.docnote {
  color: var(--muted);
  font-size: 0.80rem;
}

/* The converted markup arrives through v-html, so scoped styles reach it with
   :deep. It is our own server's output: every character of it is escaped there. */
.docx :deep(h1),
.docx :deep(h2),
.docx :deep(h3),
.docx :deep(h4) {
  margin: 1.1em 0 0.4em;
  line-height: 1.3;
}

.docx :deep(h1) {
  font-size: 1.35rem;
}

.docx :deep(h2) {
  font-size: 1.15rem;
}

.docx :deep(h3) {
  font-size: 1rem;
}

.docx :deep(h4) {
  font-size: 0.9rem;
}

.docx :deep(p) {
  margin: 0 0 0.5em;
}

/* Markers are stated outright rather than left to the default, and they are always
   CSS markers: Word's own bullet characters live in Symbol and Wingdings, whose code
   points render as empty boxes in a normal font. */
.docx :deep(ul.docx-list),
.docx :deep(ol.docx-list) {
  margin: 0 0 0.6em;
  padding-left: 1.6em;
}

.docx :deep(ul.docx-list) {
  list-style: disc outside;
}

.docx :deep(ol.docx-list) {
  list-style: decimal outside;
}

/* Nested levels get their own marker so depth is readable. */
.docx :deep(ul.docx-list ul.docx-list) {
  list-style: circle outside;
  margin-bottom: 0;
}

.docx :deep(ul.docx-list ul.docx-list ul.docx-list) {
  list-style: square outside;
}

.docx :deep(ol.docx-list ol.docx-list) {
  margin-bottom: 0;
}

.docx :deep(.docx-list li) {
  margin: 0 0 0.18em;
}

.docx :deep(.docx-list li::marker) {
  color: #1a1a1a;
}

.docx :deep(img) {
  max-width: 100%;
  height: auto;
  margin: 0.4em 0;
}

.docx :deep(table.docx-table) {
  border-collapse: collapse;
  margin: 0.6em 0;
  width: 100%;
}

.docx :deep(table.docx-table td) {
  border: 1px solid #c9c9c9;
  padding: 0.25em 0.45em;
  vertical-align: top;
}

.docx :deep(table.docx-table td p) {
  margin: 0;
}

.docx :deep(.docx-tab) {
  display: inline-block;
  width: 1.6em;
}

.docx :deep(.docx-missing) {
  color: #8a8a8a;
  font-style: italic;
}

.docx :deep(.docx-blank) {
  min-height: 0.6em;
}
</style>
