<script setup lang="ts">
import ConfirmButton from '@/components/ConfirmButton.vue';
import { computed, nextTick, ref, watch } from 'vue';
import MathText from '@/components/MathText.vue';
import {
  activeConversation,
  chatStore,
  deleteConversation,
  newConversation,
  renameConversation,
  sendMessage,
  setAttachments,
} from '@/stores/chat';
import {
  folderPath,
  folderTree,
  notesInFolder,
  notesStore,
  resolveAskNotes,
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

// Attaching is a valid FIRST action: with no conversation yet, the picker creates
// one on the spot instead of sitting disabled.
function openPicker(): void {
  if (!conv.value) newConversation();
  pickerOpen.value = true;
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
          class="ghost attach-btn"
          title="Attach notes or whole folders; every answer in this chat is grounded in them"
          @click="openPicker"
        >
          + Notes
        </button>
        <template v-if="conv">
          <span v-for="fid in conv.folderIds" :key="`f-${fid}`" class="attach-chip">
            {{ folderPath(fid) }}/*
            <button class="chip-x" :aria-label="`Detach folder ${folderPath(fid)}`" @click="toggleFolder(fid)">×</button>
          </span>
          <span v-for="nid in conv.noteIds" :key="`n-${nid}`" class="attach-chip">
            {{ noteTitle(nid) }}
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
      <div v-if="pickerOpen" class="cpicker">
        <div class="cpicker-head">
          <input
            v-model="pickerQuery"
            class="cpicker-search"
            type="search"
            placeholder="Search notes and folders…"
            aria-label="Search notes and folders"
          />
          <span class="cpicker-sum mono">{{ pickerSummary }}</span>
          <button class="ghost" @click="pickerOpen = false">Done</button>
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
            <div class="msg-time mono">{{ fmtTime(m.ts) }}</div>
          </div>
        </template>
        <div v-if="busy" class="msg assistant">
          <div class="msg-body thinking">Thinking…</div>
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

.msg {
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
  font-size: 0.92rem;
  line-height: 1.6;
  color: var(--ink);
  border-radius: var(--radius);
  padding: 0.55rem 0.8rem;
  overflow-x: auto;
}

.msg.user .msg-body {
  background: var(--panel);
  border: 1px solid var(--border);
  white-space: pre-wrap;
}

.msg.assistant .msg-body {
  background: transparent;
  border: 1px solid transparent;
  padding-left: 0;
  white-space: pre-wrap;
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

.cpicker {
  border: 1px solid var(--gold);
  border-radius: var(--radius);
  background: var(--panel);
  margin: 0 0 0.6rem;
  display: flex;
  flex-direction: column;
  min-height: 0;
  max-height: 46vh;
}

.cpicker-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.5rem 0.6rem;
  border-bottom: 1px solid var(--border);
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
</style>
