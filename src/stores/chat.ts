import { reactive } from 'vue';
import { chatAsk } from '@/ask';
import { settings } from '@/stores/settings';
import { resolveAskNotes } from '@/stores/notes';
import { ensureIndexed, retrieve } from '@/stores/retrieval';
import { colDelete, colList, colPut, dbState } from '@/db';

/**
 * Persistent study-chat conversations. Each conversation carries its own attached
 * context (note ids and folder subtrees, resolved to transcript text at send time,
 * so a note edited later feeds the next turn its newest text) and its transcript.
 * Everything lives in the file database (data/chats/*.json): the chat is a primary
 * study tool, and a study tool that forgets on a browser wipe is a toy.
 *
 * Console access: __nlChat()
 */

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
  /** Which model wrote this one. Absent on student turns and on older transcripts. */
  model?: string;
}

export interface ChatConversation {
  id: string;
  ts: number; // created
  edited: number; // last activity, drives the sidebar order
  title: string;
  noteIds: string[];
  folderIds: string[];
  messages: ChatMessage[];
  /**
   * The model this conversation runs on, when it is not the one Presets sets. Chosen
   * per conversation rather than globally because that is the unit the choice belongs
   * to: a chat that is chewing through a proof wants the expensive tier, and the one
   * that looks up vocabulary does not, and both are open at once. Empty or absent
   * means the Presets default, so a chat started before this existed keeps following
   * that setting, and changing the setting still moves every chat that never chose.
   */
  model?: string;
}

const COL = 'chats';
const MAX_MESSAGES = 400; // per conversation; beyond this the oldest turns fall off

export const chatStore = reactive({
  conversations: [] as ChatConversation[],
  activeId: '',
  ready: false,
});

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

async function persist(c: ChatConversation): Promise<void> {
  if (dbState.available) {
    try {
      await colPut(COL, c.id, plain(c));
    } catch (err) {
      console.warn('[nuclear-learning] chat persist failed:', err);
    }
  }
}

async function init(): Promise<void> {
  if (dbState.available) {
    try {
      const list = await colList<ChatConversation>(COL);
      list.sort((a, b) => b.edited - a.edited);
      chatStore.conversations = list;
      chatStore.activeId = list[0]?.id ?? '';
    } catch (err) {
      console.warn('[nuclear-learning] chat load failed:', err);
    }
  } else {
    console.warn('[nuclear-learning] file database unavailable: chats will not persist this session.');
  }
  chatStore.ready = true;
}

void init();

export function activeConversation(): ChatConversation | undefined {
  return chatStore.conversations.find((c) => c.id === chatStore.activeId);
}

export function newConversation(): ChatConversation {
  const c: ChatConversation = {
    id: newId(),
    ts: Date.now(),
    edited: Date.now(),
    title: 'New chat',
    noteIds: [],
    folderIds: [],
    messages: [],
  };
  chatStore.conversations.unshift(c);
  chatStore.activeId = c.id;
  void persist(c);
  return c;
}

export function deleteConversation(id: string): void {
  chatStore.conversations = chatStore.conversations.filter((c) => c.id !== id);
  if (chatStore.activeId === id) chatStore.activeId = chatStore.conversations[0]?.id ?? '';
  if (dbState.available) {
    void colDelete(COL, id).catch((err) => console.warn('[nuclear-learning] chat delete failed:', err));
  }
}

export function renameConversation(id: string, title: string): void {
  const c = chatStore.conversations.find((x) => x.id === id);
  if (!c || !title.trim()) return;
  c.title = title.trim().slice(0, 80);
  void persist(c);
}

/** The model a conversation runs on. '' hands it back to the Presets default. */
export function setConversationModel(id: string, model: string): void {
  const c = chatStore.conversations.find((x) => x.id === id);
  if (!c) return;
  const next = model.trim();
  c.model = next || undefined;
  void persist(c);
}

/** What the next turn of this conversation will actually be sent to. */
export function conversationModel(c: ChatConversation | undefined): string {
  return c?.model?.trim() || settings.api.chatModel;
}

export function setAttachments(id: string, noteIds: string[], folderIds: string[]): void {
  const c = chatStore.conversations.find((x) => x.id === id);
  if (!c) return;
  c.noteIds = [...noteIds];
  c.folderIds = [...folderIds];
  void persist(c);
  // Start embedding what was just attached. It runs on the background lane, so the
  // first question can be asked immediately; anything not indexed by then rides
  // along verbatim for that one turn.
  void ensureIndexed(c.noteIds, c.folderIds);
}

function touch(c: ChatConversation): void {
  c.edited = Date.now();
  chatStore.conversations.sort((a, b) => b.edited - a.edited);
}

/**
 * One turn: append the student message, resolve the conversation's attachments to
 * fresh transcript text, call the model with the transcript tail, append the reply.
 * Returns false on failure — the caller keeps the draft; the student message stays
 * in the transcript so a retry reads naturally as asking again.
 */
export async function sendMessage(convId: string, question: string): Promise<boolean> {
  const c = chatStore.conversations.find((x) => x.id === convId);
  if (!c) return false;
  const q = question.trim();
  if (!q) return false;
  // The history the model sees is the transcript BEFORE this question; the question
  // rides separately as the newest message.
  const history = c.messages.map((m) => ({ role: m.role, text: m.text }));
  c.messages.push({ role: 'user', text: q, ts: Date.now() });
  if (c.title === 'New chat') c.title = q.slice(0, 48);
  touch(c);
  void persist(c);
  const { folders } = resolveAskNotes(c.noteIds, c.folderIds);
  // Retrieval first: the passages that actually bear on THIS question, out of the
  // whole attachment, however large it is. Anything without a usable index yet goes
  // verbatim so a freshly attached folder is never silently answered without.
  const { passages, unindexed } = await retrieve(q, c.noteIds, c.folderIds);
  const notes = unindexed.length ? resolveAskNotes(unindexed.map((n) => n.id), []).notes : [];
  // Resolved here rather than inside the request, so the reply can say which model
  // wrote it even after the conversation is switched to another one.
  const model = conversationModel(c);
  const reply = await chatAsk({ question: q, notes, passages, folders, history, model });
  void ensureIndexed(c.noteIds, c.folderIds); // catch up for the next turn
  if (!reply) return false;
  c.messages.push({ role: 'assistant', text: reply, ts: Date.now(), model });
  if (c.messages.length > MAX_MESSAGES) c.messages.splice(0, c.messages.length - MAX_MESSAGES);
  touch(c);
  void persist(c);
  return true;
}

// Console probe: __nlChat() shows the conversations and where they persist.
if (typeof window !== 'undefined') {
  (window as unknown as { __nlChat: unknown }).__nlChat = () => ({
    ready: chatStore.ready,
    disk: dbState.available,
    active: chatStore.activeId,
    conversations: chatStore.conversations.map((c) => ({
      id: c.id,
      title: c.title,
      messages: c.messages.length,
      notes: c.noteIds.length,
      folders: c.folderIds.length,
      // What it runs on, and whether that is its own choice or the Presets default.
      model: conversationModel(c),
      ownModel: Boolean(c.model),
    })),
  });
}
