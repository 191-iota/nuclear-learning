<script setup lang="ts">
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

// The study chat: its own window, built to be lived in. Conversations persist on
// disk, each carries its own attached notes/folders as context, and the thread is
// the interface — ask, read, ask again. The math pad never appears here; this is
// the general half of the app.

const conv = computed(() => activeConversation());
const tree = computed(() => folderTree());
const countIn = (folderId: string) => notesInFolder(folderId, true).length;

const draft = ref('');
const busy = ref(false);
const sendFailed = ref(false);
const pickerOpen = ref(false);
// The conversation list folds away so the thread can take the whole window.
const sidebarOpen = ref(true);
const threadRef = ref<HTMLDivElement | null>(null);

const attachedInfo = computed(() => {
  const c = conv.value;
  if (!c) return { notes: [], omitted: 0, pending: 0 };
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

function onRename(id: string): void {
  const c = chatStore.conversations.find((x) => x.id === id);
  if (!c) return;
  const title = prompt('Rename chat:', c.title);
  if (title?.trim()) renameConversation(id, title);
}

function onDelete(id: string): void {
  const c = chatStore.conversations.find((x) => x.id === id);
  if (!c) return;
  if (!confirm(`Delete the chat "${c.title}"?`)) return;
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
        <button
          class="clist-row"
          :class="{ active: c.id === chatStore.activeId }"
          @click="chatStore.activeId = c.id"
        >
          <span class="clist-title">{{ c.title }}</span>
          <span class="clist-date mono">{{ fmtDate(c.edited) }}</span>
        </button>
        <span v-if="c.id === chatStore.activeId" class="clist-acts">
          <button title="Rename" @click="onRename(c.id)">✎</button>
          <button title="Delete" @click="onDelete(c.id)">×</button>
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

    <!-- Attachment picker: folders (subtrees) and single notes for THIS conversation. -->
    <div v-if="pickerOpen" class="ovl" @click.self="pickerOpen = false">
      <div class="ovl-card" role="dialog" aria-modal="true" aria-label="Chat context">
        <div class="ovl-head">
          <span>Notes for this chat</span>
          <button class="x" aria-label="Close" @click="pickerOpen = false">×</button>
        </div>
        <div class="picker-rows">
          <template v-for="t in tree" :key="t.folder.id">
            <label class="picker-row" :style="{ paddingLeft: `${t.depth * 1.1}rem` }">
              <input
                type="checkbox"
                :checked="conv?.folderIds.includes(t.folder.id) ?? false"
                @change="toggleFolder(t.folder.id)"
              />
              <span class="picker-name">{{ t.folder.name }}</span>
              <span class="picker-count mono">{{ countIn(t.folder.id) }}</span>
            </label>
            <label
              v-for="n in notesInFolder(t.folder.id)"
              :key="n.id"
              class="picker-row pnote"
              :style="{ paddingLeft: `${t.depth * 1.1 + 1.5}rem` }"
            >
              <input
                type="checkbox"
                :checked="conv?.noteIds.includes(n.id) ?? false"
                @change="toggleNote(n.id)"
              />
              <span class="picker-name">{{ n.title || (n.hasImage && !n.extracted ? 'Transcribing…' : 'Untitled') }}</span>
            </label>
          </template>
          <div v-if="notesStore.notes.length === 0" class="picker-empty">
            No notes yet. Write some in the Notebook first.
          </div>
        </div>
        <div class="picker-actions">
          <button @click="pickerOpen = false">Done</button>
        </div>
      </div>
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
  align-items: center;
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
  flex: none;
  gap: 0.1rem;
}

.clist-acts button {
  border: 0;
  background: none;
  color: var(--muted);
  padding: 0.15rem 0.3rem;
  font-size: 0.8rem;
  cursor: pointer;
}

.clist-acts button:hover {
  color: var(--ink);
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
