import OpenAI from 'openai';
import { settings } from '@/stores/settings';
import { recordUsage } from '@/stores/usage';

/**
 * Writes one tailored review card from a corrected mistake. The live grading loop
 * hands back a one-line nudge meant for self-correction mid-solve; that makes a poor
 * flashcard, because the cue ("recall the mistake you fixed") names nothing specific.
 * So once a problem is solved we spend one explicit, cheap GPT-5 mini call to turn the
 * mistake into a real card: a specific recall question on the front, the answer on
 * the back, with the math in LaTeX. Used both when a lesson is first captured and to
 * rebuild older cards that predate this.
 */
const CARD_MODEL = 'gpt-5-mini';

const CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['front', 'back'],
  properties: {
    front: { type: 'string' },
    back: { type: 'string' },
  },
};

const SYSTEM = `You turn a mistake a learner just made and corrected into ONE spaced-repetition flashcard, so they can re-test the exact thing they got wrong. You are given the problem, its worked solution, the error that was flagged, and sometimes the correction.

Return JSON {front, back}:
- "front": a SPECIFIC, self-contained question that tests the precise point the learner got wrong, phrased so they have to recall the answer themselves. Name the concrete case: the exact sub-part, expression, identity, rule, or step. Never a vague "what was your mistake" and never the bare problem statement. Do NOT reveal the answer on the front.
- "back": the correct answer, with a one-line reason, and you may name what they had wrong.
Write ALL mathematics in LaTeX between single $ delimiters (for example $a\\cdot\\bar a = 0$ or $x=\\frac{-b\\pm\\sqrt{b^2-4ac}}{2a}$). Keep each side to one or two short lines.`;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) throw new Error('Missing VITE_OPENAI_API_KEY.');
    client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true, timeout: 30000, maxRetries: 1 });
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
      max_completion_tokens: 1200,
      reasoning_effort: 'low',
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
    if (!front && !back) return null;
    return { front, back };
  } catch (err) {
    console.warn('[nuclear-learning] lesson card generation failed:', err);
    return null;
  }
}
