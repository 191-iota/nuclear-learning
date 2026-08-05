import { cleanText, createCompletion } from '@/api';
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

One slip per card — never bundle sub-parts a, b, c. Write ALL mathematics in LaTeX between single $ delimiters. Keep each side to one or two short lines. Write the card in German (Swiss Hochdeutsch, use "ss" not "ß"), even when the problem or the flagged error below is in another language — mathematics stays LaTeX, prose becomes German.

GOOD (shape, not language): front "Simplify $\\frac{1}{x-y}-\\frac{1}{y-x}$ — what sign does the second term take?"  back "$+\\frac{1}{x-y}$, giving $\\frac{2}{x-y}$, because $\\frac{1}{y-x}=-\\frac{1}{x-y}$ (the sign was flipped)."
GOOD: front "Write the pure-repeating decimal $0.\\overline{145}$ as a fraction."  back "$\\frac{145}{999}$ — three nines, because the period is three digits."
FORBIDDEN front "$\\frac{(2w-v)a}{-2(v-w)-k}$" — that is the ANSWER, not a prompt. Rewrite as e.g. "Solve for $a$: after expanding $-2(v-w)$, what is the denominator?"`;

// What a typed ask-box question reveals, curated into the deck. The writer works
// THEORY-FIRST: it distills the general rule or technique behind the question,
// checks the existing deck for a card that already tests it (a duplicate dilutes
// the deck and is reported `covered` instead of written), and only then writes the
// card on the theory itself — the learner's question is provenance, never card text.
// A GAP card re-tests the rule (recall front); an EXPANSION card sets a small task
// on the adjacent technique (do-it front on a FRESH instance, practice not
// recognition).
const ASK_SYSTEM = `You curate a learner's spaced-repetition deck. A question they typed mid-problem revealed either a GAP (a rule, constraint, or connection they do not firmly hold) or an EXPANSION (an adjacent technique worth practicing). You are given which of the two, a one-line naming of the revealed thing, the question and the tutor's answer (PROVENANCE ONLY — never card text), the problem context, and the cards already in the deck.

Return JSON {covered, front, back}.

FIRST distill the ONE piece of theory the learner actually needs: the general rule, constraint, or technique behind the question, stated the way a textbook holds it — detached from this problem's numbers and from the question's wording.

THEN check the deck list: if an existing card already tests that same piece of knowledge (same rule or technique, whatever its phrasing), return covered=true with empty "front" and "back" — a second card on the same knowledge dilutes the deck. Only genuinely new knowledge earns a card.

Otherwise covered=false and the card is written ON THE THEORY:
- kind "gap": "front" = a recall prompt that makes the learner state or apply the rule themselves ("Unter welcher Bedingung darf eine Gleichung durch eine Variable geteilt werden?"), phrased as standalone theory — never quoting or paraphrasing the learner's question, never with the answer readable off the front; "back" = the rule stated tight, plus at most one line tying it to the case it surfaced in.
- kind "expansion": "front" = ONE small task that has the learner DO the technique on a FRESH instance: changed numbers, a task verb first (Berechne, Löse, Vereinfache, Bestimme), boxable outcome; "back" = the key line of the working plus the final result.

One piece of knowledge per card. All mathematics in LaTeX between single $ delimiters. Each side one or two short lines. German (Swiss Hochdeutsch, use "ss" not "ß"), whatever language the question used.`;

// The ask writer's reply shape: the coverage verdict plus the card (empty when covered).
const ASK_CARD_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['covered', 'front', 'back'],
  properties: {
    covered: { type: 'boolean' },
    front: { type: 'string' },
    back: { type: 'string' },
  },
};

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

// One structured card-writer call on the shared model, background lane. Returns
// null on a bad card (front empty, front a bare expression, front equal to back) so
// the caller persists nothing and Rebuild can retry later; `covered: true` reports
// that the deck already tests this knowledge (ask writer only) and carries no card.
async function writeCard(
  system: string,
  user: string,
  usageMode: string,
  schema: object = CARD_SCHEMA,
): Promise<{ covered: boolean; front: string; back: string } | null> {
  try {
    const resp = await createCompletion(
      {
        model: CARD_MODEL,
        // High-effort reasoning counts against this budget; 2500 silently truncated the
        // card (finish_reason length -> unparseable -> lesson lost) on hard slips.
        max_completion_tokens: 8000,
        reasoning_effort: 'high',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'flashcard', strict: true, schema } },
      },
      // Fire-and-forget: the card must never delay the next page's first solve.
      { lane: 'background' },
    );
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: usageMode,
      model: CARD_MODEL,
      role: 'lesson',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreate: 0,
    });
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    const p = JSON.parse(out) as { covered?: boolean; front?: string; back?: string };
    if (p.covered === true) return { covered: true, front: '', back: '' };
    // The mini model occasionally mis-escapes a LaTeX backslash in its JSON: "\frac"
    // arrives as the form-feed escape \f plus "rac" (observed live), and the same class
    // hits \t, \b, \r commands. A control char has no place in a card, so it reads as
    // the swallowed backslash and is restored; likewise a doubled backslash before a
    // letter ("\\pm" inside a one-line card) is the same slip, not a KaTeX line break.
    const repair = (s: unknown) =>
      typeof s === 'string'
        ? s
            .replace(/[\b]/g, '\\b')
            .replace(/\f/g, '\\f')
            .replace(/\t/g, '\\t')
            .replace(/\r/g, '\\r')
            .replace(/\\\\(?=[a-zA-Z])/g, '\\')
        : '';
    const front = cleanText(repair(p.front)).trim();
    const back = cleanText(repair(p.back)).trim();
    // Reject a bad card so it re-queues for Rebuild rather than persisting: front empty, front is a
    // bare expression (the answer copied onto the front, with no prose), or front equals back.
    const frontProse = /[a-zA-ZäöüÄÖÜ]{2,}/.test(front.replace(/\$[^$]*\$/g, ' '));
    const bareExpr = !!front && !front.includes('?') && !frontProse;
    if ((!front && !back) || bareExpr || (!!front && norm(front) === norm(back))) return null;
    return { covered: false, front, back };
  } catch (err) {
    console.warn('[nuclear-math] card generation failed:', err);
    return null;
  }
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
  const r = await writeCard(SYSTEM, user, input.mode ?? 'lesson-card');
  return r ? { front: r.front, back: r.back } : null;
}

export interface AskCardInput {
  problem: string;
  question: string;
  answer: string;
  what: string; // the one-line naming of the revealed gap/expansion, from the ask reply
  kind: 'gap' | 'expansion';
  solution?: string;
  mode?: string;
  deck?: string[]; // one line per existing card, for the coverage check
}

export async function generateAskCard(
  input: AskCardInput,
): Promise<{ covered: boolean; front: string; back: string } | null> {
  const user = [
    `Kind: ${input.kind}`,
    `Revealed: ${input.what || '(work it out from the question)'}`,
    `The learner's question (provenance only): ${input.question}`,
    input.answer ? `The tutor's answer: ${input.answer}` : '',
    `Problem: ${input.problem || '(unlabelled)'}`,
    input.solution ? `Reference solution:\n${input.solution}` : '',
    input.deck?.length
      ? `Cards already in the deck (newest first):\n${input.deck.map((d, i) => `${i + 1}. ${d}`).join('\n')}`
      : 'The deck is empty.',
    'Write the card, or report it covered.',
  ]
    .filter(Boolean)
    .join('\n');
  return writeCard(ASK_SYSTEM, user, input.mode ?? 'ask-card', ASK_CARD_SCHEMA);
}
