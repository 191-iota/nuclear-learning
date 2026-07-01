import OpenAI from 'openai';
import { settings } from '@/stores/settings';
import { recordUsage } from '@/stores/usage';

/**
 * Writes one tailored review card from a corrected mistake. The live grading loop
 * hands back a one-line nudge meant for self-correction mid-solve; that makes a poor
 * flashcard, because the cue ("recall the mistake you fixed") names nothing specific.
 * So once a problem is solved we spend one explicit GPT-5.4 mini (high-effort) call to turn the
 * mistake into a real card: a specific recall question on the front, the answer on
 * the back, with the math in LaTeX. It writes the HARDEST transform in the app (invent a recall
 * question that isolates the slip and withholds the answer), so it runs at HIGH reasoning effort.
 * Used both when a lesson is first captured and to rebuild older cards.
 */
const CARD_MODEL = 'gpt-5.4-mini';

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['front', 'back'],
  properties: {
    front: { type: 'string' },
    back: { type: 'string' },
  },
};

const SYSTEM = `You turn a math mistake a learner just made and corrected into ONE spaced-repetition flashcard that re-tests the EXACT thing they got wrong.

You are given: the problem, its full worked solution (context for YOU only — never quote its final answer on the front), the error that was flagged, and SOMETIMES an explicit correction (wrong vs right).

Return JSON {front, back}.

"front" — a SPECIFIC prompt that makes the learner reproduce the ONE step, identity, sign, or rule they got wrong.
- It may be a question, a compute-imperative ("Simplify ...", "Solve ... for a"), or a cloze/fill-in ("... = ?"), but it MUST contain natural-language words, not be a bare expression.
- Name the concrete case: the exact sub-expression / identity / step. Never "what was your mistake", never the plain problem statement.
- HARD RULE: the front must NOT contain the final answer or the corrected result, and must NOT be an expression copied verbatim from the worked solution. If the answer can be read straight off the front, rewrite it. front and back must never be the same expression.
- If no explicit correction is given, work out the specific slip yourself from the worked solution and prompt for THAT step — do not paste a line of the solution as the front.

"back" — the correct result, plus a one-line reason; you may name what they had wrong.

One slip per card — never bundle sub-parts a, b, c. Write ALL mathematics in LaTeX between single $ delimiters. Keep each side to one or two short lines. Write the card in the SAME language as the flagged error and correction below.

GOOD (shape, not language): front "Simplify $\\frac{1}{x-y}-\\frac{1}{y-x}$ — what sign does the second term take?"  back "$+\\frac{1}{x-y}$, giving $\\frac{2}{x-y}$, because $\\frac{1}{y-x}=-\\frac{1}{x-y}$ (the sign was flipped)."
GOOD: front "Write the pure-repeating decimal $0.\\overline{145}$ as a fraction."  back "$\\frac{145}{999}$ — three nines, because the period is three digits."
FORBIDDEN front "$\\frac{(2w-v)a}{-2(v-w)-k}$" — that is the ANSWER, not a prompt. Rewrite as e.g. "Solve for $a$: after expanding $-2(v-w)$, what is the denominator?"`;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) throw new Error('Missing VITE_OPENAI_API_KEY.');
    client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true, timeout: 90000, maxRetries: 1 });
  }
  return client;
}

export interface LessonCardInput {
  problem: string;
  mistake: string;
  solution: string;
  wrong?: string;
  right?: string;
  mode?: string;
}

export async function generateLessonCard(
  input: LessonCardInput,
): Promise<{ front: string; back: string } | null> {
  try {
    const german = settings.api.feedbackLang === 'German';
    const lang = german ? '\n\nWrite the card in German (Swiss Hochdeutsch, use "ss" not "ß").' : '';
    const user = [
      `Problem: ${input.problem || '(unlabelled)'}`,
      input.solution ? `Worked solution:\n${input.solution}` : '',
      `Flagged error: ${input.mistake}`,
      input.wrong || input.right
        ? `Correction: wrong = ${input.wrong || '(n/a)'} ; right = ${input.right || '(n/a)'}`
        : '',
      'Write the card.',
    ]
      .filter(Boolean)
      .join('\n');
    const resp = await getClient().chat.completions.create({
      model: CARD_MODEL,
      max_completion_tokens: 2500,
      reasoning_effort: 'high',
      messages: [
        { role: 'system', content: SYSTEM + lang },
        { role: 'user', content: user },
      ],
      response_format: { type: 'json_schema', json_schema: { name: 'flashcard', strict: true, schema: CARD_SCHEMA } },
    } as any);
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: input.mode ?? 'lesson-card',
      model: CARD_MODEL,
      role: 'lesson',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreate: 0,
    });
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    const p = JSON.parse(out) as { front?: string; back?: string };
    const front = (p.front ?? '').trim();
    const back = (p.back ?? '').trim();
    // Reject a bad card so it re-queues for Rebuild rather than persisting: front empty, front is a
    // bare expression (the answer copied onto the front, with no prose), or front equals back.
    const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
    const frontProse = /[a-zA-ZäöüÄÖÜ]{2,}/.test(front.replace(/\$[^$]*\$/g, ' '));
    const bareExpr = !!front && !front.includes('?') && !frontProse;
    if ((!front && !back) || bareExpr || (!!front && norm(front) === norm(back))) return null;
    return { front, back };
  } catch (err) {
    console.warn('[nuclear-learning] lesson card generation failed:', err);
    return null;
  }
}
