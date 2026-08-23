import { reactive } from 'vue';
import { noteAsk } from '@/ask';

/**
 * The question window that floats over the page being written: one short thread per
 * note, for the things you are unsure about while writing rather than for studying
 * afterwards. The study chat next door is the other one, and it is deliberately not
 * this: that one has a whole notebook attached and answers at length; this one has the
 * page in front of you and answers the question.
 *
 * Threads live in localStorage under an nl.* key, so they mirror to disk with
 * everything else and survive a reload. They are capped hard on both axes: a
 * throwaway question about a page is worth keeping for the rest of the evening, not
 * forever, and this store must never grow into a second chat archive.
 *
 * Console access: __nlNoteAsk()
 */

export interface AskMsg {
  role: 'user' | 'assistant';
  text: string;
  ts: number;
}

const KEY = 'nl.noteAsk.v1';
const MAX_THREADS = 12;
const MAX_MESSAGES = 24;
/** The key a board with no note behind it yet writes under. */
export const DRAFT_KEY = 'draft';

function load(): Record<string, AskMsg[]> {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) || '{}') as Record<string, AskMsg[]>;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, AskMsg[]> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (Array.isArray(v)) out[k] = v.filter((m) => m && typeof m.text === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

export const noteAskStore = reactive({
  threads: load() as Record<string, AskMsg[]>,
  busy: false,
  /** Set while the page is being read, which is the slow half when it happens at all. */
  reading: false,
  failed: false,
});

function save(): void {
  // Oldest threads fall off first, by the last thing said in them.
  const entries = Object.entries(noteAskStore.threads).filter(([, v]) => v.length);
  entries.sort((a, b) => (b[1][b[1].length - 1]?.ts ?? 0) - (a[1][a[1].length - 1]?.ts ?? 0));
  const kept = Object.fromEntries(entries.slice(0, MAX_THREADS));
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* storage unavailable, non-fatal */
  }
}

export function thread(key: string): AskMsg[] {
  return noteAskStore.threads[key] ?? [];
}

export function clearThread(key: string): void {
  delete noteAskStore.threads[key];
  save();
}

/**
 * A board that had no note behind it now has one. The questions asked while it was
 * still nameless belong to it, so they move across rather than being stranded under a
 * key that the next new note will reuse.
 */
export function adoptThread(from: string, to: string): void {
  if (from === to) return;
  const msgs = noteAskStore.threads[from];
  if (!msgs?.length) return;
  noteAskStore.threads[to] = [...(noteAskStore.threads[to] ?? []), ...msgs];
  delete noteAskStore.threads[from];
  save();
}

export interface AskContext {
  title: string;
  path: string;
  /** What is on the page, as text: the note's transcript or a fresh read of the board. */
  text: string;
  /** The student's own context for the note. */
  context: string;
  folders: { path: string; context: string }[];
}

/**
 * One question. The answer lands in the thread; false means nothing came back and the
 * caller puts the question back in the box for a one-keypress retry.
 */
export async function askNote(key: string, question: string, ctx: AskContext): Promise<boolean> {
  const q = question.trim();
  if (!q) return false;
  const msgs = noteAskStore.threads[key] ?? [];
  const history = msgs.map((m) => ({ role: m.role, text: m.text }));
  msgs.push({ role: 'user', text: q, ts: Date.now() });
  noteAskStore.threads[key] = msgs;
  save();
  const reply = await noteAsk({
    question: q,
    note: { title: ctx.title, path: ctx.path, text: ctx.text, context: ctx.context },
    folders: ctx.folders,
    history,
  });
  if (!reply) {
    noteAskStore.failed = true;
    return false;
  }
  msgs.push({ role: 'assistant', text: reply, ts: Date.now() });
  if (msgs.length > MAX_MESSAGES) msgs.splice(0, msgs.length - MAX_MESSAGES);
  noteAskStore.threads[key] = msgs;
  save();
  return true;
}

if (typeof window !== 'undefined') {
  (window as unknown as { __nlNoteAsk: unknown }).__nlNoteAsk = () => ({
    busy: noteAskStore.busy,
    reading: noteAskStore.reading,
    threads: Object.entries(noteAskStore.threads).map(([k, v]) => ({ key: k, messages: v.length })),
  });
}
