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

Rules:
- Ground answers in the attached notes wherever they bear on the question, and name the note you draw on ("laut deiner Notiz 'Zellatmung' ..."). Where the notes are silent, answer from general knowledge and say so briefly. Where a note is factually wrong, say so plainly and give the correction. Never invent note content.
- When the student asks you to check or correct THEIR work, work through what the attached transcripts actually contain, item by item. If the content they refer to is NOT in the transcripts (a note marked as having no transcript, or the material simply missing), say exactly that and what you would need — never deliver a generic model answer dressed up as a correction of their work.
- Whatever language the student writes in, answer in German (Swiss Hochdeutsch, use "ss" not "ß") — unless the question explicitly asks for another language; a vocabulary or translation task keeps its target language.
- Declarative and concrete; no praise, no filler, no restating the question. Depth follows the question: a lookup gets two lines, an explanation gets structure — short paragraphs, enumerations one item per line, a worked example over an abstract description. End a longer explanation with the ONE sentence that carries the core.
- Every mathematical, chemical, or physical expression in $-LaTeX between single $ delimiters ($$...$$ on its own line for a centerpiece formula).

Reply as JSON: "reply" = the full answer exactly as it should appear in the chat, line breaks where they belong. The chat renders full markdown: "#"-"####" headings, **bold**, *italic*, \`inline code\`, fenced \`\`\` code blocks, "- " and "1. " lists (one sublevel via two-space indent), "> " quotes, | pipe | tables | with a |---|---| separator line, "---" rules, [links](https://...). Use whatever carries the answer best: tables for comparisons, lists for steps and enumerations, code fences for code. Math stays in $-LaTeX as above, inside list items and table cells too.`;

const HISTORY_TURNS = 12; // context window of prior turns per request
const HISTORY_CHARS = 6000;

/**
 * One chat turn. Returns the reply text, or null on any failure (the caller keeps
 * the draft and shows a retry line). Stateless: the conversation store owns the
 * transcript, this builds one request from its tail.
 */
export async function chatAsk(input: {
  question: string;
  notes: AskNoteBlock[];
  history: ChatTurn[];
}): Promise<string | null> {
  try {
    const lines: string[] = [];
    if (input.notes.length) {
      lines.push(
        'Notes the student attached to this conversation (transcripts; structure preserved, math as $-LaTeX):',
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
    } else {
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

    const model = settings.api.chatModel;
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
    if (modelInfo(model).effort && settings.api.chatEffort !== 'none') {
      params.reasoning_effort = settings.api.chatEffort;
    }
    const resp = await createCompletion(params, { timeout: 90000 });
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: 'chat',
      model,
      role: 'ask',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreate: 0,
    });
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    const parsed = JSON.parse(out) as { reply?: string };
    const reply = cleanText(parsed.reply).trim();
    return reply || null;
  } catch (err) {
    console.warn('[nuclear-math] chat turn failed:', err);
    return null;
  }
}
