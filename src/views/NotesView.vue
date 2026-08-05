<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import MathText from '@/components/MathText.vue';
import { useTablet, type TabletStroke } from '@/composables/useTablet';
import { makeThumb } from '@/stores/archive';
import {
  INBOX_ID,
  addFolder,
  addTypedNote,
  deleteFolder,
  deleteNote,
  folderPath,
  folderTree,
  loadNoteBg,
  loadNoteImage,
  loadNoteInk,
  notesInFolder,
  notesStore,
  reExtractNote,
  renameFolder,
  saveNoteFromPad,
  searchNotes,
  updateNote,
  updateNoteInk,
  type Note,
} from '@/stores/notes';

// The Notebook: the notes half of Notes mode, purely about capturing and organizing.
// School notes of any subject are written HERE (own ink editor, no grader, no
// scratch divider), organized into nested folders with tags, searched as text.
// Questions about them belong to the Chat window next door, which attaches these
// notes as transcripts; the math tutor never sees them unless a math page attaches
// them on the pad.

const selected = ref<string>(''); // '' = all notes
const query = ref('');

const tree = computed(() => folderTree());
const results = computed(() => searchNotes(query.value, selected.value || undefined));
const countIn = (folderId: string) => notesInFolder(folderId, true).length;

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

// ---- clipboard: a copied image pastes straight into the notebook ----

// Cmd+V with an image (screenshot, phone photo, textbook snippet) creates an image
// note in the selected folder and the background transcriber picks it up exactly
// like a pad capture. Text pastes keep their default behavior everywhere.
function fileToDataUrl(f: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('read failed'));
    r.readAsDataURL(f);
  });
}

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
  for (const f of files) {
    try {
      const img = await fileToDataUrl(f);
      const thumb = await makeThumb(img);
      const n = await saveNoteFromPad({ image: img, thumb }, selected.value || INBOX_ID);
      selected.value = n.folderId;
    } catch (err) {
      console.warn('[nuclear-math] image paste failed:', err);
    }
  }
}

// ---- folder actions ----

function onNewFolder(parentId: string | null): void {
  const name = prompt(parentId ? 'Subfolder name:' : 'Folder name:');
  if (name?.trim()) {
    const f = addFolder(name, parentId);
    selected.value = f.id;
  }
}

function onRenameFolder(id: string): void {
  const f = tree.value.find((t) => t.folder.id === id)?.folder;
  if (!f) return;
  const name = prompt('Rename folder:', f.name);
  if (name?.trim()) renameFolder(id, name);
}

function onDeleteFolder(id: string): void {
  if (!confirm('Delete this folder? Its notes and subfolders move one level up.')) return;
  deleteFolder(id);
  if (selected.value === id) selected.value = '';
}

// ---- the ink editor: writing notes directly, no pad involved ----

const inkOpen = ref(false);
const inkCanvasRef = ref<HTMLCanvasElement | null>(null);
const inkWrapRef = ref<HTMLDivElement | null>(null);
// scratch:false — a general note has no "not graded" region, the whole page is the note.
const ink = useTablet(inkCanvasRef, { scratch: false });
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
  }
  inkFolder.value = selected.value || INBOX_ID;
  inkOpen.value = true; // the canvas mounts and useTablet sizes it via its ref watcher
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
  if (n.hasBg) {
    const bg = await loadNoteBg(n.id);
    if (bg) ink.setBackdrop(bg);
  } else if (!strokes) {
    const img = openImage.value || (await loadNoteImage(n.id));
    if (!img) return;
    ink.setBackdrop(img);
    legacyBg.value = img; // becomes the note's permanent backdrop on save
  }
  editingNote.value = n;
  inkFolder.value = n.folderId;
  open.value = null;
  openImage.value = '';
  inkOpen.value = true;
}

function closeInk(): void {
  // The draft stays on the canvas: closing is pausing, saving is the commit.
  inkOpen.value = false;
}

async function saveInk(): Promise<void> {
  if (inkSaving.value) return;
  const img = ink.exportImage('all');
  if (!img) {
    closeInk();
    return;
  }
  inkSaving.value = true;
  try {
    const thumb = await makeThumb(img);
    const editing = editingNote.value;
    if (editing) {
      await updateNoteInk(editing.id, {
        image: img,
        thumb,
        strokes: ink.getStrokes(),
        bg: legacyBg.value || undefined,
      });
      if (editing.folderId !== inkFolder.value) updateNote(editing.id, { folderId: inkFolder.value });
      selected.value = inkFolder.value;
      editingNote.value = null;
      legacyBg.value = '';
    } else {
      const n = await saveNoteFromPad({ image: img, thumb, strokes: ink.getStrokes() }, inkFolder.value);
      selected.value = n.folderId;
    }
    ink.clear();
    inkOpen.value = false;
  } catch (err) {
    console.warn('[nuclear-math] ink note save failed:', err);
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

function onKeys(e: KeyboardEvent): void {
  if (e.isComposing) return;
  if (e.key === 'Escape') {
    if (inkOpen.value) closeInk();
    else if (open.value) closeOpen();
    else return;
    e.preventDefault();
    return;
  }
  if (!inkOpen.value || isEditableTarget(e.target)) return;
  const mod = e.metaKey || e.ctrlKey;
  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (mod && !e.altKey && k === 'z') {
    if (e.shiftKey) ink.redo();
    else ink.undo();
    e.preventDefault();
    return;
  }
  if (mod && !e.altKey && k === 'y') {
    ink.redo();
    e.preventDefault();
    return;
  }
  if (mod || e.altKey) return;
  switch (k) {
    case 'z':
      ink.undo();
      e.preventDefault();
      break;
    case 'y':
      ink.redo();
      e.preventDefault();
      break;
    case 'e':
      ink.toggleEraser();
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
  window.addEventListener('paste', onPaste);
  document.addEventListener('fullscreenchange', onFsChange);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWinResize);
  window.removeEventListener('keydown', onKeys);
  window.removeEventListener('paste', onPaste);
  document.removeEventListener('fullscreenchange', onFsChange);
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

async function openNote(n: Note): Promise<void> {
  open.value = n;
  draftTitle.value = n.title;
  draftText.value = n.text;
  draftContext.value = n.context;
  draftTags.value = n.tags.join(', ');
  draftFolder.value = n.folderId;
  openImage.value = '';
  if (n.hasImage) openImage.value = await loadNoteImage(n.id);
}

function saveOpen(): void {
  const n = open.value;
  if (!n) return;
  updateNote(n.id, {
    title: draftTitle.value.trim(),
    text: draftText.value,
    context: draftContext.value,
    tags: draftTags.value.split(',').map((t) => t.trim()).filter(Boolean),
    folderId: draftFolder.value,
  });
}

function closeOpen(): void {
  // Closing saves: notes apps autosave, and losing an edited transcript to a stray
  // click would break the trust the transcript exists for.
  saveOpen();
  open.value = null;
  openImage.value = '';
}

function onDeleteNote(): void {
  const n = open.value;
  if (!n) return;
  if (!confirm(`Delete the note "${n.title || 'Untitled'}"?`)) return;
  void deleteNote(n.id);
  open.value = null;
}

async function onReExtract(): Promise<void> {
  const n = open.value;
  if (!n || busyExtract.value) return;
  busyExtract.value = true;
  try {
    await reExtractNote(n.id);
    draftTitle.value = n.title;
    draftText.value = n.text;
    draftTags.value = n.tags.join(', ');
  } finally {
    busyExtract.value = false;
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

function excerpt(n: Note): string {
  return n.text.length > 180 ? `${n.text.slice(0, 180)}…` : n.text;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
</script>

<template>
  <section class="notes-layout">
    <aside class="ntree" :style="{ width: `${treeW}px` }">
      <button class="ntree-row" :class="{ active: selected === '' }" @click="selected = ''">
        <span class="ntree-name">All notes</span>
        <span class="ntree-count mono">{{ notesStore.notes.length }}</span>
      </button>
      <div v-for="t in tree" :key="t.folder.id" class="ntree-item">
        <button
          class="ntree-row"
          :class="{ active: selected === t.folder.id }"
          :style="{ paddingLeft: `${0.6 + t.depth * 0.85}rem` }"
          @click="selected = t.folder.id"
        >
          <span class="ntree-name">{{ t.folder.name }}</span>
          <span class="ntree-count mono">{{ countIn(t.folder.id) }}</span>
        </button>
        <span v-if="selected === t.folder.id" class="ntree-acts">
          <button title="New subfolder" @click="onNewFolder(t.folder.id)">+</button>
          <button v-if="t.folder.id !== INBOX_ID" title="Rename" @click="onRenameFolder(t.folder.id)">✎</button>
          <button v-if="t.folder.id !== INBOX_ID" title="Delete (contents move up)" @click="onDeleteFolder(t.folder.id)">×</button>
        </span>
      </div>
      <button class="ghost newfolder" @click="onNewFolder(null)">+ Folder</button>
    </aside>

    <div
      class="vsplit"
      role="separator"
      aria-orientation="vertical"
      title="Drag to resize the folder tree; double-click resets"
      @pointerdown="startTreeDrag"
      @dblclick="resetTreeW"
    />

    <div class="nmain scroll">
      <div class="page-head">
        <h2>{{ selected ? folderPath(selected) : 'Notes' }}</h2>
        <span class="count mono">{{ results.length }}</span>
        <span class="spacer" />
        <button class="ghost" title="Write a note with the pen, right here" @click="openInk">+ Ink note</button>
        <button class="ghost" @click="onNewTypedNote">+ Text note</button>
      </div>

      <input
        v-model="query"
        class="search"
        type="search"
        placeholder="Search notes: title, tag, content…"
        aria-label="Search notes"
      />

      <div v-if="notesStore.notes.length === 0" class="empty">
        No notes yet. "+ Ink note" opens a pen page right here; the Note button on the
        math pad captures a solving page; "+ Text note" types one. Every ink note is
        transcribed to searchable text in the background. Organize whenever you feel
        like it.
      </div>
      <div v-else-if="results.length === 0" class="empty">No match here. Try another word or the All notes view.</div>

      <div class="ngrid">
        <button v-for="n in results" :key="n.id" class="ncard" @click="openNote(n)">
          <img v-if="n.thumb" :src="n.thumb" alt="" class="nthumb" />
          <span class="ncard-body">
            <span class="ntitle-row">
              <span class="ntitle">{{ n.title || (n.hasImage && !n.extracted ? 'Transcribing…' : 'Untitled') }}</span>
              <span
                class="pin"
                :class="{ on: n.pinned }"
                role="button"
                :title="n.pinned ? 'Unpin' : 'Pin to top'"
                @click="togglePin(n, $event)"
              >★</span>
            </span>
            <span v-if="!n.thumb && n.text" class="nexcerpt">{{ excerpt(n) }}</span>
            <span class="nmeta mono">
              {{ fmtDate(n.ts) }} · {{ folderPath(n.folderId) }}
              <span v-if="n.hasImage && !n.extracted" class="npending"> · transcribing…</span>
            </span>
            <span v-if="n.tags.length" class="ntags">
              <span v-for="t in n.tags" :key="t" class="tag">{{ t }}</span>
            </span>
          </span>
        </button>
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
        <button :disabled="inkSaving || !ink.state.hasInk" @click="saveInk">
          {{ inkSaving ? 'Saving…' : 'Save note' }}
        </button>
        <button class="ghost" title="Back to the notebook; the draft stays (Esc)" @click="closeInk">Close</button>
      </div>
      <div ref="inkWrapRef" class="inkwrap">
        <canvas
          ref="inkCanvasRef"
          class="inkpad"
          :class="{ erasing: ink.state.tool === 'eraser' }"
          aria-label="Note writing area"
        />
        <div class="tooldock" role="toolbar" aria-label="Ink tools">
          <button :disabled="!ink.state.canUndo" title="Undo stroke (Z, or the pen's lower button)" @click="ink.undo()">Undo</button>
          <button :disabled="!ink.state.canRedo" title="Redo (Y)" @click="ink.redo()">Redo</button>
          <button
            :class="{ on: ink.state.tool === 'eraser' }"
            title="Stroke eraser (E)"
            @click="ink.toggleEraser()"
          >
            Eraser
          </button>
          <span class="zoomlvl">{{ ink.state.zoomPct }}%</span>
          <button title="Zoom out (-)" @click="ink.zoomBy(0.8)">−</button>
          <button title="Zoom in (+); ctrl+scroll zooms at the cursor" @click="ink.zoomBy(1.25)">+</button>
          <button title="Fit the page (0)" @click="ink.resetView()">Fit</button>
          <button
            title="Fullscreen writing: the page fills the screen, so the tablet maps ~1:1 onto it (Esc leaves)"
            @click="toggleFullscreen"
          >
            Full
          </button>
        </div>
      </div>
    </div>

    <!-- Note detail: the image beside its editable transcript. -->
    <div v-if="open" class="ovl" @click.self="closeOpen">
      <div ref="noteWinRef" class="ovl-card" :style="noteWinStyle" role="dialog" aria-modal="true" aria-label="Note">
        <div class="ovl-head">
          <input v-model="draftTitle" class="title-edit" type="text" placeholder="Title" aria-label="Note title" />
          <button class="x" aria-label="Close" title="Close (saves)" @click="closeOpen">×</button>
        </div>
        <div class="detail-grid" :class="{ single: !openImage }">
          <img v-if="openImage" :src="openImage" class="nimg" alt="Handwritten note" />
          <div class="detail-fields">
            <label class="f-label ctx-label">Context — yours, the LLM never writes here
              <textarea
                v-model="draftContext"
                rows="4"
                class="text-edit ctx-edit"
                placeholder="Dump anything: the assignment this belongs to, where it came from, what it is for. Rides into every chat this note is attached to."
              />
            </label>
            <label class="f-label">Transcript / content (LLM-seeded)
              <textarea v-model="draftText" rows="10" class="text-edit" />
            </label>
            <label class="f-label">Tags (LLM-seeded, comma-separated)
              <input v-model="draftTags" type="text" />
            </label>
            <label class="f-label">Folder
              <select v-model="draftFolder">
                <option v-for="t in tree" :key="t.folder.id" :value="t.folder.id">
                  {{ ' '.repeat(t.depth * 2) + t.folder.name }}
                </option>
              </select>
            </label>
            <div v-if="open.text" class="preview">
              <div class="f-label">Rendered</div>
              <div class="preview-body"><MathText :text="draftText" /></div>
            </div>
          </div>
        </div>
        <div class="ovl-actions">
          <button @click="saveOpen">Save</button>
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
            title="Transcribe the image again (overwrites machine-filled fields)"
            @click="onReExtract"
          >
            {{ busyExtract ? 'Transcribing…' : 'Re-transcribe' }}
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
          <button class="ghost danger" @click="onDeleteNote">Delete</button>
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
  align-items: center;
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
  font-size: 0.84rem;
  color: var(--ink);
  cursor: pointer;
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
  font-size: 0.64rem;
  color: var(--muted);
}

.ntree-acts {
  display: flex;
  gap: 0.1rem;
  flex: none;
}

.ntree-acts button {
  border: 0;
  background: none;
  color: var(--muted);
  padding: 0.15rem 0.3rem;
  font-size: 0.8rem;
  cursor: pointer;
}

.ntree-acts button:hover {
  color: var(--ink);
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
  font-size: 0.75rem;
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
  font-size: 0.85rem;
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
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.35;
}

.pin {
  flex: none;
  color: var(--border);
  font-size: 0.9rem;
  cursor: pointer;
}

.pin.on {
  color: var(--gold);
}

.pin:hover {
  color: var(--gold);
}

.nexcerpt {
  font-size: 0.78rem;
  color: var(--muted);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  white-space: pre-line;
}

.nmeta {
  font-size: 0.66rem;
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
  font-size: 0.66rem;
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

.ovl-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 14px 48px rgba(0, 0, 0, 0.25);
  width: min(1020px, 96vw);
  max-height: 88vh;
  overflow-y: auto;
  padding: 1rem 1.3rem 1.2rem;
}

.ovl-head {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 0.5rem;
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

/* Corner grip of the note window: sticky, so it stays put while the card scrolls;
   the chosen size persists across notes and sessions. */
.win-grip {
  position: sticky;
  bottom: 0;
  display: block;
  width: 16px;
  height: 16px;
  margin: 0.3rem -0.9rem -0.9rem auto;
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

.ink-folder {
  font-size: 0.7rem;
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
  font-size: 0.72rem;
  padding: 0.3rem 0.55rem;
}

.tooldock button.on {
  border-color: var(--gold);
  color: var(--gold);
}

.tooldock .zoomlvl {
  font-family: var(--mono);
  font-size: 0.68rem;
  color: var(--muted);
  min-width: 3ch;
  text-align: right;
  padding: 0 0.15rem;
  font-variant-numeric: tabular-nums;
}

/* Detail */
.title-edit {
  flex: 1;
  min-width: 0;
  font-size: 1rem;
  font-weight: 600;
}

.detail-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
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

.nimg {
  display: block;
  max-width: 100%;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  align-self: start;
}

.detail-fields {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
}

.f-label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-family: var(--mono);
  font-size: 0.68rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}

.text-edit {
  width: 100%;
  resize: vertical;
  font-size: 0.86rem;
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

.preview-body {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.5rem 0.7rem;
  font-size: 0.88rem;
  line-height: 1.55;
  color: var(--ink);
  max-height: 14rem;
  overflow: auto;
  text-transform: none;
  letter-spacing: normal;
  font-family: var(--sans);
}

.ovl-actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.9rem;
  flex-wrap: wrap;
}

.pin-toggle {
  font-size: 0.8rem;
}
</style>
