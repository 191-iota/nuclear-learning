<script setup lang="ts">
import ConfirmButton from '@/components/ConfirmButton.vue';
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import FloatWindow from '@/components/FloatWindow.vue';
import MathText from '@/components/MathText.vue';
import {
  activeConversation,
  chatStore,
  conversationModel,
  deleteConversation,
  newConversation,
  renameConversation,
  sendMessage,
  setAttachments,
  setConversationModel,
} from '@/stores/chat';
import { settings } from '@/stores/settings';
import { MODELS } from '@/models';
import {
  folderPath,
  folderTree,
  loadNoteImage,
  notesInFolder,
  notesStore,
  resolveAskNotes,
  type Note,
} from '@/stores/notes';
import { retrievalState } from '@/stores/retrieval';

// The study chat: its own window, built to be lived in. Conversations persist on
// disk, each carries its own attached notes/folders as context, and the thread is
// the interface — ask, read, ask again. The math pad never appears here; this is
// the general half of the app.

const conv = computed(() => activeConversation());
const tree = computed(() => folderTree());

const draft = ref('');
const busy = ref(false);
const sendFailed = ref(false);
const pickerOpen = ref(false);
// The conversation list folds away so the thread can take the whole window.
const sidebarOpen = ref(true);
const threadRef = ref<HTMLDivElement | null>(null);

// ---- the attachment picker ----
//
// It used to be a modal over the thread holding a flat checkbox list of the whole
// tree, with no search, no way to see what a folder actually pulls in, and no sign
// of whether a note had any text to contribute. It is now a panel inside the chat
// column that says what the selection costs and what is wrong with it.

const pickerQuery = ref('');

interface PickerRow {
  key: string;
  kind: 'folder' | 'note';
  id: string;
  depth: number;
  name: string;
  count: number;
  covered: boolean; // a note already pulled in by a selected folder
  hasText: boolean;
}

/** Every folder whose subtree a selected folder already covers. */
const coveredNotes = computed(() => {
  const c = conv.value;
  const ids = new Set<string>();
  if (!c) return ids;
  for (const fid of c.folderIds) for (const n of notesInFolder(fid, true)) ids.add(n.id);
  return ids;
});

const pickerRows = computed<PickerRow[]>(() => {
  const q = pickerQuery.value.trim().toLowerCase();
  const hit = (s: string) => !q || s.toLowerCase().includes(q);
  const rows: PickerRow[] = [];
  for (const t of tree.value) {
    const notes = notesInFolder(t.folder.id).filter(
      (n) => hit(n.title) || hit(n.text.slice(0, 400)) || hit(t.folder.name),
    );
    const folderHit = hit(t.folder.name);
    // A folder is shown when it matches, or when something inside it does, so a
    // search never orphans a result from the place it lives.
    if (!folderHit && !notes.length) continue;
    rows.push({
      key: `f-${t.folder.id}`,
      kind: 'folder',
      id: t.folder.id,
      depth: t.depth,
      name: t.folder.name,
      count: notesInFolder(t.folder.id, true).length,
      covered: false,
      hasText: true,
    });
    for (const n of notes) {
      rows.push({
        key: `n-${n.id}`,
        kind: 'note',
        id: n.id,
        depth: t.depth + 1,
        name: n.title || (n.hasImage && !n.extracted ? 'Transcribing…' : 'Untitled'),
        count: 0,
        covered: coveredNotes.value.has(n.id),
        hasText: Boolean(n.text.trim() || n.context.trim()),
      });
    }
  }
  return rows;
});

/** What the selection actually amounts to, in the units that matter. */
const pickerSummary = computed(() => {
  const info = attachedInfo.value;
  if (!info.notes.length) return 'nothing attached';
  const chars = info.notes.reduce((sum, n) => sum + n.text.length + n.context.length, 0);
  const size = chars > 1500 ? `${Math.round(chars / 1000)}k chars` : `${chars} chars`;
  const bits = [`${info.notes.length} note${info.notes.length === 1 ? '' : 's'}`, size];
  if (info.pending) bits.push(`${info.pending} still transcribing`);
  if (retrievalState.indexing) bits.push(`indexing ${retrievalState.indexing}`);
  return bits.join(' · ');
});

const attachedInfo = computed(() => {
  const c = conv.value;
  if (!c) return { notes: [], folders: [], omitted: 0, pending: 0 };
  return resolveAskNotes(c.noteIds, c.folderIds);
});

function onNew(): void {
  newConversation();
  draft.value = '';
  sendFailed.value = false;
}

// ---- which model answers ----
//
// Per conversation, because that is the unit the choice belongs to: the chat working
// through a proof and the chat looking up vocabulary are both open, and they do not
// want the same tier. A chat that never chooses follows the Presets setting, so the
// old behaviour is still what happens by default and the setting still moves it.
//
// The list is the shipped one plus a way to type an id, matching Presets: a model
// pulled after this build has to be usable the moment it lands.

const OTHER = '@other'; // a select value no model id can collide with

const typingModel = ref(false);
const modelDraft = ref('');

/** What the next turn will be sent to, named the way the shipped list names it. */
function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}

const activeModel = computed(() => conversationModel(conv.value));

const modelTitle = computed(() => {
  const id = activeModel.value;
  const known = MODELS.some((m) => m.id === id);
  const where = known
    ? 'one of the models this build ships with'
    : 'not in the shipped list, so it answers only if ollama has pulled it';
  const source = conv.value?.model ? 'this chat' : 'the Presets default';
  return `Every turn of this chat runs on ${id} (${where}), set by ${source}.`;
});

function onModelPick(value: string): void {
  if (value === OTHER) {
    modelDraft.value = conv.value?.model ?? '';
    typingModel.value = true;
    return;
  }
  const c = conv.value ?? newConversation();
  setConversationModel(c.id, value);
}

function commitModel(): void {
  if (!typingModel.value) return;
  typingModel.value = false;
  const c = conv.value ?? newConversation();
  setConversationModel(c.id, modelDraft.value);
}

// Attaching is a valid FIRST action: with no conversation yet, the picker creates
// one on the spot instead of sitting disabled.
function openPicker(): void {
  if (!conv.value) newConversation();
  pickerOpen.value = !pickerOpen.value;
}

/**
 * Closing the picker is the part that was wrong. It opened as a tall panel over the
 * thread and the only way out was a Done button at the far right of its header, a
 * whole window's travel from the row you had just ticked. Now it closes the way every
 * other transient thing in this app closes: Enter, Esc, or clicking somewhere else.
 * Ticking rows stays multi-select, so none of those three commits anything; they only
 * put the panel away.
 */
const pickerRef = ref<HTMLElement | null>(null);
const attachBtnRef = ref<HTMLElement | null>(null);

function closePicker(): void {
  pickerOpen.value = false;
}

function onDocDown(e: PointerEvent): void {
  const t = e.target as Node | null;
  if (!t) return;
  // The toggle button owns its own click; closing here first would just reopen it.
  if (pickerRef.value?.contains(t) || attachBtnRef.value?.contains(t)) return;
  closePicker();
}

function onPickerKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') closePicker();
}

watch(pickerOpen, (open) => {
  if (open) {
    document.addEventListener('pointerdown', onDocDown, true);
    window.addEventListener('keydown', onPickerKey);
  } else {
    document.removeEventListener('pointerdown', onDocDown, true);
    window.removeEventListener('keydown', onPickerKey);
    pickerQuery.value = '';
  }
});

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocDown, true);
  window.removeEventListener('keydown', onPickerKey);
});

// ---- a note, open beside the thread ----
//
// Reading a note and asking about it are the same act, and sending the reader to the
// Notebook tab to do the first half loses the second. So an attached note opens in a
// window that floats over this one: movable, resizable, and left where it was put.

const openNoteId = ref('');
const openNoteImage = ref('');

const openNote = computed<Note | null>(
  () => notesStore.notes.find((n) => n.id === openNoteId.value) ?? null,
);

const attachedIds = computed(() => {
  const c = conv.value;
  if (!c) return [] as string[];
  const ids = new Set<string>(c.noteIds);
  for (const fid of c.folderIds) for (const n of notesInFolder(fid, true)) ids.add(n.id);
  return [...ids];
});

/** Everything this conversation has attached, as the list the window pages through. */
const attachedNotes = computed(() =>
  attachedIds.value
    .map((id) => notesStore.notes.find((n) => n.id === id))
    .filter((n): n is Note => Boolean(n)),
);

/** Whether the picture is showing at full size. Off by default (see the template). */
const imgBig = ref(false);

async function showNote(id: string): Promise<void> {
  openNoteId.value = id;
  openNoteImage.value = '';
  imgBig.value = false;
  const n = notesStore.notes.find((x) => x.id === id);
  if (n?.hasImage) {
    const img = await loadNoteImage(id);
    // The window may have moved on to another note while the picture loaded.
    if (openNoteId.value === id) openNoteImage.value = img;
  }
}

// Renaming a chat happens on its own row in the list, not in an OS prompt box.
const renamingId = ref('');
const renameDraft = ref('');

const vFocus = {
  mounted: (el: HTMLInputElement) => {
    el.focus();
    el.select();
  },
};

function startRename(id: string, title: string): void {
  renamingId.value = id;
  renameDraft.value = title;
}

function commitRename(): void {
  const id = renamingId.value;
  renamingId.value = '';
  if (id && renameDraft.value.trim()) renameConversation(id, renameDraft.value);
}

function onDelete(id: string): void {
  deleteConversation(id);
}

function toggleFolder(id: string): void {
  const c = conv.value;
  if (!c) return;
  const folders = c.folderIds.includes(id)
    ? c.folderIds.filter((x) => x !== id)
    : [...c.folderIds, id];
  setAttachments(c.id, c.noteIds, folders);
}

function toggleNote(id: string): void {
  const c = conv.value;
  if (!c) return;
  const notes = c.noteIds.includes(id) ? c.noteIds.filter((x) => x !== id) : [...c.noteIds, id];
  setAttachments(c.id, notes, c.folderIds);
}

function noteTitle(id: string): string {
  return notesStore.notes.find((n) => n.id === id)?.title || 'Untitled';
}

async function onSend(): Promise<void> {
  const q = draft.value.trim();
  if (!q || busy.value) return;
  let c = conv.value;
  if (!c) c = newConversation();
  busy.value = true;
  sendFailed.value = false;
  draft.value = '';
  try {
    const ok = await sendMessage(c.id, q);
    if (!ok) {
      // The question stays in the transcript; the draft comes back for one-keypress retry.
      sendFailed.value = true;
      draft.value = q;
    }
  } finally {
    busy.value = false;
  }
}

function scrollToEnd(): void {
  void nextTick(() => {
    const el = threadRef.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

watch(
  () => [chatStore.activeId, conv.value?.messages.length, busy.value],
  scrollToEnd,
);

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('de-CH', { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
</script>

<template>
  <section class="chat-layout">
    <aside v-show="sidebarOpen" class="clist">
      <button class="ghost newchat" @click="onNew">+ New chat</button>
      <div v-for="c in chatStore.conversations" :key="c.id" class="clist-item">
        <div v-if="renamingId === c.id" class="clist-edit">
          <input
            v-model="renameDraft"
            v-focus
            class="clist-input"
            aria-label="Chat name"
            @keydown.enter="commitRename"
            @keydown.esc="renamingId = ''"
            @blur="commitRename"
          />
        </div>
        <button
          v-else
          class="clist-row"
          :class="{ active: c.id === chatStore.activeId }"
          @click="chatStore.activeId = c.id"
        >
          <span class="clist-title">{{ c.title }}</span>
          <span class="clist-date mono">{{ fmtDate(c.edited) }}</span>
        </button>
        <span v-if="c.id === chatStore.activeId && renamingId !== c.id" class="clist-acts">
          <button @click="startRename(c.id, c.title)">Rename</button>
          <ConfirmButton
            label="Delete"
            confirm-label="Delete it"
            :title="`Delete the chat ${c.title}`"
            @confirm="onDelete(c.id)"
          />
        </span>
      </div>
      <div v-if="chatStore.conversations.length === 0" class="clist-empty">
        One chat per subject or topic keeps context tight.
      </div>
    </aside>

    <div class="cmain">
      <!-- The conversation's context: what the answers are grounded in. -->
      <div class="cctx">
        <button
          class="ghost attach-btn"
          :title="sidebarOpen ? 'Hide the chat list — full-width thread' : 'Show the chat list'"
          @click="sidebarOpen = !sidebarOpen"
        >
          {{ sidebarOpen ? '⟨ Chats' : '⟩ Chats' }}
        </button>
        <button
          ref="attachBtnRef"
          class="ghost attach-btn"
          :class="{ on: pickerOpen }"
          title="Attach notes or whole folders; every answer in this chat is grounded in them"
          @click="openPicker"
        >
          + Notes
        </button>
        <button
          v-if="attachedNotes.length"
          class="ghost attach-btn"
          title="Read a note in a window over this one, while the conversation stays where it is"
          @click="showNote(openNoteId || attachedNotes[0].id)"
        >
          Open note
        </button>
        <!-- Which model answers, for this conversation. Typing an id is offered for
             the same reason Presets offers it: a model released after this build
             should be usable the day it lands. -->
        <input
          v-if="typingModel"
          v-model="modelDraft"
          v-focus
          class="model-in mono"
          list="nl-chat-models"
          type="text"
          spellcheck="false"
          autocapitalize="off"
          placeholder="model id"
          aria-label="Model id for this chat"
          @keydown.enter.prevent="commitModel"
          @keydown.esc.prevent="typingModel = false"
          @blur="commitModel"
        />
        <select
          v-else
          class="model-sel mono"
          :value="conv?.model ?? ''"
          :title="modelTitle"
          aria-label="Model for this chat"
          @change="onModelPick(($event.target as HTMLSelectElement).value)"
        >
          <option value="">Default · {{ modelLabel(settings.api.chatModel) }}</option>
          <option v-if="conv?.model && !MODELS.some((m) => m.id === conv?.model)" :value="conv.model">
            {{ conv.model }}
          </option>
          <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
          <option :value="OTHER">Other model id…</option>
        </select>
        <template v-if="conv">
          <span v-for="fid in conv.folderIds" :key="`f-${fid}`" class="attach-chip">
            {{ folderPath(fid) }}/*
            <button class="chip-x" :aria-label="`Detach folder ${folderPath(fid)}`" @click="toggleFolder(fid)">×</button>
          </span>
          <span v-for="nid in conv.noteIds" :key="`n-${nid}`" class="attach-chip">
            <!-- The chip is the way into the note: reading it is what you wanted the
                 moment you noticed it was attached. -->
            <button class="chip-open" :title="`Read ${noteTitle(nid)} beside the chat`" @click="showNote(nid)">
              {{ noteTitle(nid) }}
            </button>
            <button class="chip-x" :aria-label="`Detach note ${noteTitle(nid)}`" @click="toggleNote(nid)">×</button>
          </span>
          <span v-if="!conv.folderIds.length && !conv.noteIds.length" class="cctx-hint mono">
            No notes attached — answers run on general knowledge.
          </span>
          <span v-else class="cctx-hint mono">
            {{ attachedInfo.notes.length }} note{{ attachedInfo.notes.length === 1 ? '' : 's' }} in context<template
              v-if="attachedInfo.pending > 0"
            >
              · {{ attachedInfo.pending }} transcribing</template
            >
          </span>
        </template>
      </div>

      <!-- Attachment picker: a panel in the chat column, not a modal over the thread.
           Folders take their whole subtree; a note already covered by one is shown as
           such instead of being silently redundant. -->
      <div v-if="pickerOpen" ref="pickerRef" class="cpicker">
        <div class="cpicker-head">
          <!-- Done sits where the pointer already is, under the + Notes button that
               opened this. Enter and Esc do the same thing from the keyboard. -->
          <button class="ghost" title="Put the picker away (Enter or Esc). Your ticks are already saved." @click="closePicker">
            Done
          </button>
          <input
            v-model="pickerQuery"
            v-focus
            class="cpicker-search"
            type="search"
            placeholder="Search notes and folders…"
            aria-label="Search notes and folders"
            @keydown.enter.prevent="closePicker"
            @keydown.esc.prevent="closePicker"
          />
          <span class="cpicker-sum mono">{{ pickerSummary }}</span>
        </div>
        <div class="cpicker-rows">
          <label
            v-for="row in pickerRows"
            :key="row.key"
            class="picker-row"
            :class="{ pnote: row.kind === 'note', dim: row.covered }"
            :style="{ paddingLeft: `${0.3 + row.depth * 1.1}rem` }"
          >
            <input
              type="checkbox"
              :checked="
                row.kind === 'folder'
                  ? (conv?.folderIds.includes(row.id) ?? false)
                  : row.covered || (conv?.noteIds.includes(row.id) ?? false)
              "
              :disabled="row.covered"
              @change="row.kind === 'folder' ? toggleFolder(row.id) : toggleNote(row.id)"
            />
            <span class="picker-name">{{ row.name }}</span>
            <span v-if="row.kind === 'folder'" class="picker-tag mono">
              {{ row.count }} note{{ row.count === 1 ? '' : 's' }} with subfolders
            </span>
            <span v-else-if="row.covered" class="picker-tag mono">already in, via its folder</span>
            <span v-else-if="!row.hasText" class="picker-tag mono warn">nothing to contribute yet</span>
          </label>
          <div v-if="!pickerRows.length" class="picker-empty">
            {{ notesStore.notes.length ? 'Nothing matches that.' : 'No notes yet. Write some in the Notebook first.' }}
          </div>
        </div>
      </div>

      <div ref="threadRef" class="cthread">
        <div v-if="!conv || conv.messages.length === 0" class="cwelcome">
          <p>
            This chat is grounded in your own notes: attach a folder above and every
            answer draws on those transcripts, quoting the note it uses. Without
            attachments it answers from general knowledge.
          </p>
          <p class="muted">Enter sends · Shift+Enter for a new line.</p>
        </div>
        <template v-if="conv">
          <div v-for="(m, i) in conv.messages" :key="i" class="msg" :class="m.role">
            <div class="msg-body">
              <MathText v-if="m.role === 'assistant'" :text="m.text" rich />
              <template v-else>{{ m.text }}</template>
            </div>
            <!-- An answer says which model wrote it, so a thread that changed model
                 halfway is readable as one afterwards. -->
            <div class="msg-time mono">
              {{ fmtTime(m.ts) }}<template v-if="m.model"> · {{ modelLabel(m.model) }}</template>
            </div>
          </div>
        </template>
        <div v-if="busy" class="msg assistant">
          <div class="msg-body thinking">{{ modelLabel(activeModel) }} is thinking…</div>
        </div>
        <div v-if="sendFailed" class="sendfail mono">No answer came back. The question is back in the box — Enter retries.</div>
      </div>

      <form class="composer" @submit.prevent="onSend">
        <textarea
          v-model="draft"
          rows="2"
          class="composer-input"
          placeholder="Ask anything about your material…"
          aria-label="Chat message"
          @keydown.enter.exact.prevent="onSend"
        />
        <button type="submit" :disabled="busy || !draft.trim()">{{ busy ? '…' : 'Send' }}</button>
      </form>
    </div>

    <!-- Suggestions for the model box, the same shipped list Presets offers. -->
    <datalist id="nl-chat-models">
      <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
    </datalist>

    <!-- A note, open over the thread: drag it aside, size it to the page, keep asking. -->
    <FloatWindow
      v-if="openNote"
      pane-key="chatNote"
      :title="openNote.title || 'Untitled'"
      :w="520"
      :h="600"
      :min-w="320"
      :min-h="240"
      @close="openNoteId = ''"
    >
      <template #actions>
        <select
          v-if="attachedNotes.length > 1"
          class="nw-pick"
          :value="openNoteId"
          title="Another of this chat's notes"
          @change="showNote(($event.target as HTMLSelectElement).value)"
        >
          <option v-for="n in attachedNotes" :key="n.id" :value="n.id">
            {{ n.title || 'Untitled' }}
          </option>
        </select>
      </template>
      <div class="nw-body">
        <p class="nw-path mono">{{ folderPath(openNote.folderId) }}</p>
        <!-- Capped, because a handwriting picture at full window width fills the whole
             window and pushes the text of the note below the fold. Click for the whole
             page when the handwriting is what you came to read. -->
        <button
          v-if="openNoteImage"
          class="nw-imgbtn"
          :title="imgBig ? 'Smaller' : 'Show the whole page'"
          @click="imgBig = !imgBig"
        >
          <img :src="openNoteImage" class="nw-img" :class="{ big: imgBig }" alt="The note as it was written" />
        </button>
        <p v-if="openNote.context" class="nw-ctx">{{ openNote.context }}</p>
        <MathText v-if="openNote.text" :text="openNote.text" rich />
        <p v-else-if="!openNoteImage" class="nw-empty mono">
          {{ openNote.hasImage ? 'Still being transcribed.' : 'Nothing written in this note yet.' }}
        </p>
      </div>
    </FloatWindow>
  </section>
</template>

<style scoped>
.chat-layout {
  display: flex;
  height: 100%;
  min-height: 0;
}

.clist {
  width: 250px;
  flex: none;
  border-right: 1px solid var(--border);
  background: var(--panel);
  padding: 0.7rem 0.5rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.newchat {
  margin-bottom: 0.5rem;
  align-self: stretch;
}

.clist-item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
}

.clist-row {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.1rem;
  border: 0;
  background: none;
  text-align: left;
  padding: 0.4rem 0.6rem;
  border-radius: var(--radius);
  cursor: pointer;
  color: var(--ink);
}

.clist-row:hover {
  background: var(--bg);
}

.clist-row.active {
  background: var(--bg);
}

.clist-title {
  font-size: 0.84rem;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.clist-row.active .clist-title {
  font-weight: 650;
}

.clist-date {
  font-size: 0.62rem;
  color: var(--muted);
}

.clist-acts {
  display: flex;
  flex-wrap: wrap;
  flex: none;
  gap: 0.3rem;
  padding: 0.15rem 0.2rem 0.35rem 0.5rem;
}

.clist-acts button {
  border: 1px solid var(--border);
  background: var(--panel);
  color: var(--muted);
  border-radius: var(--radius);
  padding: 0.2rem 0.45rem;
  font-size: 0.78rem;
  cursor: pointer;
}

.clist-acts button:hover {
  color: var(--ink);
  border-color: var(--muted);
}

.clist-acts :deep(.confirm-btn.armed) {
  color: var(--accent-ink);
  background: var(--bad);
  border-color: var(--bad);
}

/* Renaming in place, on the row the chat already occupies. */
.clist-edit {
  display: flex;
  padding: 0.1rem 0.2rem;
}

.clist-input {
  flex: 1;
  min-width: 0;
  font-size: 0.88rem;
  padding: 0.28rem 0.5rem;
}

.clist-empty {
  color: var(--muted);
  font-size: 0.74rem;
  line-height: 1.5;
  padding: 0.6rem 0.6rem;
}

.cmain {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.cctx {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0.55rem 0.9rem;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.attach-btn {
  font-size: 0.7rem;
  padding: 0.2rem 0.55rem;
}

/* The model picker sits with the other things that describe the conversation rather
   than with the composer: it belongs to the whole thread, not to the next message. */
.model-sel,
.model-in {
  flex: none;
  max-width: 12rem;
  font-size: 0.7rem;
  padding: 0.2rem 0.35rem;
}

.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-family: var(--mono);
  font-size: 0.66rem;
  color: var(--ink);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.12rem 0.3rem 0.12rem 0.55rem;
  max-width: 100%;
}

.chip-x {
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1;
  padding: 0 0.15rem;
  cursor: pointer;
}

.chip-x:hover {
  color: var(--bad);
}

.cctx-hint {
  font-size: 0.64rem;
  color: var(--muted);
}

.cthread {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 1rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}

.cwelcome {
  max-width: 40rem;
  margin: auto;
  color: var(--ink);
  font-size: 0.9rem;
  line-height: 1.6;
  text-align: center;
}

.cwelcome .muted {
  color: var(--muted);
  font-size: 0.76rem;
}

/* flex: none for the same reason as the question window's messages: a turn that is
   taller than the thread must make the THREAD scroll, and a shrinkable item wrapping a
   scroll container collapses into a little scrolling box of its own instead. */
.msg {
  flex: none;
  min-width: 0;
  max-width: min(64rem, 98%);
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.msg.user {
  align-self: flex-end;
  align-items: flex-end;
}

.msg.assistant {
  align-self: flex-start;
}

.msg-body {
  min-width: 0;
  font-size: 0.92rem;
  line-height: 1.6;
  color: var(--ink);
  border-radius: var(--radius);
  padding: 0.55rem 0.8rem;
}

.msg.user .msg-body {
  background: var(--panel);
  border: 1px solid var(--border);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

/* No pre-wrap on an answer: it is rendered markup, and MathText sets what it needs. */
.msg.assistant .msg-body {
  background: transparent;
  border: 1px solid transparent;
  padding-left: 0;
}

.msg-body.thinking {
  color: var(--muted);
  font-family: var(--mono);
  font-size: 0.78rem;
}

.msg-time {
  font-size: 0.6rem;
  color: var(--muted);
  padding: 0 0.2rem;
}

.sendfail {
  align-self: center;
  font-size: 0.7rem;
  color: var(--bad);
}

.composer {
  display: flex;
  gap: 0.6rem;
  align-items: flex-end;
  padding: 0.7rem 0.9rem;
  border-top: 1px solid var(--border);
  background: var(--panel);
}

.composer-input {
  flex: 1;
  min-width: 0;
  font-size: 0.92rem;
  line-height: 1.5;
  resize: vertical;
  max-height: 45vh;
}

/* Picker overlay */
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
  width: min(640px, 94vw);
  max-height: 82vh;
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

/* A third of the window rather than half of it: the picker is a thing you pass
   through, and it used to bury the conversation it belongs to. */
.cpicker {
  border: 1px solid var(--gold);
  border-radius: var(--radius);
  background: var(--panel);
  margin: 0 0 0.6rem;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 32vh;
}

.cpicker-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.4rem 0.5rem;
  border-bottom: 1px solid var(--border);
}

.attach-btn.on {
  border-color: var(--gold);
  color: var(--gold);
}

.cpicker-search {
  flex: 1;
  min-width: 0;
  font-size: 0.88rem;
  padding: 0.35rem 0.55rem;
}

.cpicker-sum {
  flex: none;
  font-size: 0.76rem;
  color: var(--muted);
}

.cpicker-rows {
  overflow-y: auto;
  padding: 0.3rem;
}

.picker-row.dim {
  opacity: 0.6;
}

.picker-tag {
  flex: none;
  font-size: 0.72rem;
  color: var(--muted);
}

.picker-tag.warn {
  color: var(--gold);
}

.picker-rows {
  display: flex;
  flex-direction: column;
  max-height: 55vh;
  overflow-y: auto;
}

.picker-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.28rem 0.4rem;
  font-size: 0.85rem;
  border-radius: var(--radius);
  cursor: pointer;
}

.picker-row:hover {
  background: var(--bg);
}

.picker-row.pnote {
  font-size: 0.8rem;
  color: var(--muted);
}

.picker-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.picker-count {
  font-size: 0.64rem;
  color: var(--muted);
}

.picker-empty {
  color: var(--muted);
  font-size: 0.8rem;
  padding: 0.6rem 0.4rem;
}

.picker-actions {
  display: flex;
  align-items: center;
  margin-top: 0.8rem;
}

/* The note window over the thread */
.chip-open {
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  padding: 0;
  cursor: pointer;
  max-width: 16rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-open:hover {
  color: var(--gold);
}

.nw-pick {
  max-width: 11rem;
  font-size: 0.72rem;
  padding: 0.15rem 0.3rem;
}

.nw-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0.7rem 0.85rem 1rem;
  font-size: 0.88rem;
  line-height: 1.6;
  color: var(--ink);
}

.nw-path {
  margin: 0 0 0.5rem;
  font-size: 0.68rem;
  color: var(--muted);
}

.nw-imgbtn {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  background: none;
  cursor: zoom-in;
}

.nw-imgbtn:hover .nw-img {
  border-color: var(--gold);
}

.nw-img {
  display: block;
  width: 100%;
  max-height: 11rem;
  object-fit: contain;
  object-position: left top;
  margin-bottom: 0.6rem;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.nw-img.big {
  max-height: none;
}

/* The student's own framing, marked as theirs the way it is everywhere else. */
.nw-ctx {
  margin: 0 0 0.7rem;
  padding: 0.4rem 0.6rem;
  font-size: 0.82rem;
  white-space: pre-wrap;
  color: var(--ink);
  border-left: 2px solid var(--gold);
  background: var(--bg);
  border-radius: var(--radius);
}

.nw-empty {
  color: var(--muted);
  font-size: 0.78rem;
}
</style>
