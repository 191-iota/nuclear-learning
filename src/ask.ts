import { cleanText, createCompletion } from '@/api';
import { settings } from '@/stores/settings';
import { modelInfo } from '@/models';
import { recordUsage } from '@/stores/usage';
import type { AskNoteBlock } from '@/composables/useFeedback';

/**
 * The study chat's model call. The chat is its own window and the student's primary
 * study tool: general-purpose (any school subject), grounded in the notes attached
 * to the conversation, with the conversation itself as context. Deliberately
 * separate from the math grader — that persona owns handwritten pages on the pad,
 * this one owns the notebook and everything else.
 */

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

const CHAT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply'],
  properties: {
    reply: { type: 'string' },
  },
};

const CHAT_SYSTEM = `You are the study chat for one Swiss student — their primary tool for working through school material of ANY subject, not only mathematics. Each request carries the notes the student attached to this conversation (transcripts of their own handwritten or typed notes) and the conversation so far; you answer the newest student message.

A request may also open with what the student has written about the SUBJECT each note belongs to (the folder context): how the module is examined, what past papers looked like, what the lecturer keeps asking. Treat that as standing background about the course, true of every note under it. It is the student's own words, never a transcript, so it is never something to correct; use it to aim the answer (exam-relevant emphasis, the notation this course uses, the level to pitch at).

Rules:
- Material may arrive as retrieved PASSAGES: extracts chosen for this question out of a larger notebook. They are excerpts, so absence from them is not evidence a note is silent on something; say what you would need rather than concluding the notes do not cover it. Cite the note a passage came from by its title.
- Ground answers in the attached notes wherever they bear on the question, and name the note you draw on ("laut deiner Notiz 'Zellatmung' ..."). Where the notes are silent, answer from general knowledge and say so briefly. Where a note is factually wrong, say so plainly and give the correction. Never invent note content.
- When the student asks you to check or correct THEIR work, work through what the attached transcripts actually contain, item by item. If the content they refer to is NOT in the transcripts (a note marked as having no transcript, or the material simply missing), say exactly that and what you would need — never deliver a generic model answer dressed up as a correction of their work.
- Whatever language the student writes in, answer in German (Swiss Hochdeutsch, use "ss" not "ß") — unless the question explicitly asks for another language; a vocabulary or translation task keeps its target language.
- Declarative and concrete; no praise, no filler, no restating the question. Depth follows the question: a lookup gets two lines, an explanation gets structure — short paragraphs, enumerations one item per line, a worked example over an abstract description. End a longer explanation with the ONE sentence that carries the core.
- Every mathematical, chemical, or physical expression in $-LaTeX between single $ delimiters ($$...$$ on its own line for a centerpiece formula).

Reply as JSON: "reply" = the full answer exactly as it should appear in the chat, line breaks where they belong. The chat renders full markdown: "#"-"####" headings, **bold**, *italic*, \`inline code\`, fenced \`\`\` code blocks, "- " and "1. " lists (one sublevel via two-space indent), "> " quotes, | pipe | tables | with a |---|---| separator line, "---" rules, [links](https://...). Use whatever carries the answer best: tables for comparisons, lists for steps and enumerations, code fences for code. Math stays in $-LaTeX as above, inside list items and table cells too.`;

const HISTORY_TURNS = 12; // context window of prior turns per request
const HISTORY_CHARS = 6000;

/**
 * The question window that sits over the page being written. It exists for the moment
 * mid-note where something is uncertain ("heisst das jetzt Kongruenz oder Ähnlichkeit",
 * "ist $\tan' = 1/\cos^2$"), and it answers that and stops.
 *
 * The pad's tutor gives hints on purpose; this one must not. The student is in the
 * middle of writing their own page, and an unasked-for "als Nächstes könntest du ..."
 * takes the work away from them at exactly the moment they are doing it. So the rule
 * here is the strict one: the question, its answer, nothing after it.
 */
const NOTE_ASK_SYSTEM = `You answer single questions from a Swiss student who is in the middle of writing a note. The request carries the note they are writing (their own context for it and its transcript), what they have written about the subject it is filed under, and the few questions before this one.

Answer THE QUESTION AND NOTHING ELSE. This is the hard rule of this window:
- No hints, no nudges, no next steps, no "als Nächstes", no suggestions about what to write, work out, check or revise.
- Nothing about the rest of the note beyond what the question asks.
- No praise, no encouragement, no restating the question, no offer to help further.
- The student is doing the work. You are here for the one thing they were unsure about.

How to answer:
- As short as the question allows: a fact gets one sentence, a definition gets one or two, a "why" gets the reason and stops. Go longer only when the question genuinely has parts, and then answer the parts.
- Say it outright. If the answer is yes, start with yes.
- The note is context for understanding the question, not a thing to comment on. Use it to read what "das hier" refers to, and say so plainly when the transcript does not contain what they are pointing at (a page written since the last transcription will not be in it).
- Where you are unsure or the answer depends on a convention their course fixes, say that in one clause rather than guessing confidently.
- Answer in German (Swiss Hochdeutsch, "ss" not "ß"), unless the question is explicitly about another language.
- Every mathematical, chemical or physical expression in $-LaTeX between single $ delimiters.

Reply as JSON: "reply" = the answer as it should appear, nothing else in it.`;

/**
 * One turn of that window. The note arrives as text that already exists: its stored
 * transcript, its context, its folder background. Nothing here reads the board, which
 * is what keeps a question cheap; the caller decides when a page has changed enough to
 * be worth transcribing again, and that call is the note's own, not this one's.
 */
export async function noteAsk(input: {
  question: string;
  note: { title: string; path: string; text: string; context: string } | null;
  folders?: { path: string; context: string }[];
  history: ChatTurn[];
}): Promise<string | null> {
  try {
    const lines: string[] = [];
    if (input.folders?.length) {
      lines.push('What the student says about the subject this note is filed under:');
      for (const f of input.folders) lines.push('', `[Folder: ${f.path}]`, f.context);
      lines.push('');
    }
    const n = input.note;
    if (n) {
      lines.push(`The note being written: "${n.title || 'Untitled'}" (folder: ${n.path})`);
      if (n.context) lines.push('', `The student's own context for it: ${n.context}`);
      if (n.text) lines.push('', 'Its transcript so far:', n.text);
      else lines.push('', '[This note has no transcript yet, so what is on the page is unknown here.]');
      lines.push('', '[End of the note]');
    } else {
      lines.push('No note is open; answer the question on its own.');
    }
    const tail: string[] = [];
    let used = 0;
    for (let i = input.history.length - 1; i >= 0 && tail.length < 6; i -= 1) {
      const t = input.history[i];
      const line = `${t.role === 'user' ? 'Student' : 'You'}: ${t.text}`;
      if (used + line.length > 2500) break;
      used += line.length;
      tail.unshift(line);
    }
    if (tail.length) lines.push('', 'Earlier questions in this window (oldest first):', ...tail);
    lines.push('', `The question: ${input.question}`);

    const model = settings.api.chatModel;
    const params: any = {
      model,
      // An answer here is a few sentences; the ceiling is for the model's own thinking.
      max_completion_tokens: Math.min(settings.api.maxTokens, 8000),
      messages: [
        { role: 'system', content: NOTE_ASK_SYSTEM },
        { role: 'user', content: lines.join('\n') },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'note_ask_reply', strict: true, schema: CHAT_SCHEMA },
      },
    };
    if (modelInfo(model).effort) {
      params.reasoning_effort = settings.api.chatEffort || 'none';
    }
    // Local tokens arrive slower than hosted ones, and the first request after a boot
    // waits for the weights as well, so the window is wider than the answer needs.
    const resp = await createCompletion(params, { timeout: 120000 });
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: 'notes',
      model,
      role: 'ask',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
    });
    const parsed = JSON.parse((resp.choices?.[0]?.message?.content ?? '').trim()) as { reply?: string };
    const reply = cleanText(parsed.reply).trim();
    return reply || null;
  } catch (err) {
    console.warn('[nuclear-learning] note question failed:', err);
    return null;
  }
}

/**
 * One chat turn. Returns the reply text, or null on any failure (the caller keeps
 * the draft and shows a retry line). Stateless: the conversation store owns the
 * transcript, this builds one request from its tail.
 */
export async function chatAsk(input: {
  question: string;
  notes: AskNoteBlock[];
  /** Folder background the student wrote, outermost first. See NoteFolder.context. */
  folders?: { path: string; context: string }[];
  /** Retrieved passages, most relevant first. See stores/retrieval.ts. */
  passages?: { noteId: string; title: string; path: string; text: string; score: number }[];
  history: ChatTurn[];
  /** The conversation's own model, when it has picked one. Presets otherwise. */
  model?: string;
}): Promise<string | null> {
  try {
    const lines: string[] = [];
    // The subject before the pages. A folder's context is what the module IS: how
    // it is examined, what past papers looked like, what the lecturer keeps asking.
    // It is stated once, ahead of the notes, and applies to all of them.
    if (input.folders?.length) {
      lines.push("What the student says about the subjects these notes belong to:");
      for (const f of input.folders) {
        lines.push('', `[Folder: ${f.path}]`, f.context);
      }
      lines.push('');
    }
    // Retrieved passages: the parts of the attached notebook that match this
    // question. A folder of a whole term arrives as a dozen relevant extracts
    // rather than as the first 9000 characters of it.
    if (input.passages?.length) {
      lines.push(
        'Passages retrieved from the student\'s own notes for THIS question, most relevant first. Each is an extract, not a whole note:',
      );
      input.passages.forEach((p, i) => {
        lines.push('', `[Passage ${i + 1} — from "${p.title}" in ${p.path}]`, p.text);
      });
      lines.push('', '[End of retrieved passages]');
    }
    if (input.notes.length) {
      lines.push(
        input.passages?.length
          ? 'These notes are attached but not yet indexed, so they are given in full:'
          : 'Notes the student attached to this conversation (transcripts; structure preserved, math as $-LaTeX):',
      );
      input.notes.forEach((n, i) => {
        lines.push('', `[Note ${i + 1}: "${n.title}" — folder: ${n.path}]`);
        // The context is the student's own framing (assignment, source, purpose) —
        // often the half that decides what a question about the note actually means.
        if (n.context) lines.push(`Student's own context for this note: ${n.context}`);
        if (n.text) lines.push(n.text);
        else lines.push('[This note has NO transcript — its page carried no readable content. Only the context above exists.]');
      });
      lines.push('', '[End of attached notes]');
    } else if (!input.passages?.length) {
      lines.push('No notes are attached to this conversation; answer from general knowledge.');
    }
    // The conversation tail, oldest first, bounded in turns and characters so a long
    // study session cannot grow the request without limit.
    const tail: string[] = [];
    let used = 0;
    for (let i = input.history.length - 1; i >= 0 && tail.length < HISTORY_TURNS; i -= 1) {
      const t = input.history[i];
      const line = `${t.role === 'user' ? 'Student' : 'You'}: ${t.text}`;
      if (used + line.length > HISTORY_CHARS) break;
      used += line.length;
      tail.unshift(line);
    }
    if (tail.length) {
      lines.push('', 'The conversation so far (oldest first):', ...tail);
    }
    lines.push('', `The student's newest message: ${input.question}`);

    // Per conversation, falling back to the setting. The effort stays global: it is tuned
    // to what this persona does, and it is always sent, 'none' included, since leaving it
    // out is what turns thinking ON at the other end (api.ts).
    const model = input.model?.trim() || settings.api.chatModel;
    const params: any = {
      model,
      max_completion_tokens: settings.api.maxTokens,
      messages: [
        { role: 'system', content: CHAT_SYSTEM },
        { role: 'user', content: lines.join('\n') },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'chat_reply', strict: true, schema: CHAT_SCHEMA },
      },
    };
    if (modelInfo(model).effort) {
      params.reasoning_effort = settings.api.chatEffort || 'none';
    }
    const resp = await createCompletion(params, { timeout: 180000 });
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: 'chat',
      model,
      role: 'ask',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
    });
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    const parsed = JSON.parse(out) as { reply?: string };
    const reply = cleanText(parsed.reply).trim();
    return reply || null;
  } catch (err) {
    console.warn('[nuclear-learning] chat turn failed:', err);
    return null;
  }
}
