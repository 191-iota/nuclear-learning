import kcDefs from '@config/kc.v1.json';
import exemplarDefs from '@config/exemplars.v1.json';

/**
 * The fixed knowledge-component taxonomy (config/kc.v1.json). This is the closed
 * vocabulary the solve/confirm assessor tags handwritten work against: 125 immutable
 * leaf skills across 11 domains, depth-3 slug `domain.topic.skill`.
 *
 * Slugs are PRIMARY KEYS. Only ever ADD leaves; never rename a shipped id, because
 * the per-skill history in localStorage keys on the id. The id enum sent to the
 * model and the labelled list shown to the model are both built from this one file,
 * so there is no drift between what the schema accepts and what the prompt explains.
 */
export interface KCDef {
  id: string;
  domain: string; // explicit, not derived from the prefix (the three stat.* ids map to prob)
  topic: string;
  label: string;
  kind: 'fact' | 'concept' | 'procedure';
  level: 1 | 2 | 3 | 4 | 5; // curriculum difficulty of the skill itself, the difficulty anchor
}

export const KC_DEFS = kcDefs as KCDef[];
export const KC_IDS: string[] = KC_DEFS.map((d) => d.id);
export const KC_SET = new Set(KC_IDS);
const KC_BY_ID = new Map(KC_DEFS.map((d) => [d.id, d]));

// Domains in display order, with a one-line gloss used in the assessor prompt.
export interface DomainMeta {
  key: string;
  label: string;
  gloss: string;
}
export const DOMAINS: DomainMeta[] = [
  { key: 'core', label: 'Universal atomic', gloss: 'arithmetic, signs, fractions, rearranging, substitution, used in every domain' },
  { key: 'num', label: 'Number', gloss: 'integers, fractions, powers, roots, number theory, complex numbers' },
  { key: 'alg', label: 'Algebra', gloss: 'expanding, factoring, equations, inequalities, small systems' },
  { key: 'fn', label: 'Functions', gloss: 'domain and range, composition, inverse, linear, quadratic, rational, exp and log' },
  { key: 'seq', label: 'Sequences and series', gloss: 'arithmetic and geometric, sums, convergence, induction' },
  { key: 'calc', label: 'Calculus', gloss: 'limits, derivatives, integrals, optimization, differential equations' },
  { key: 'la', label: 'Linear algebra', gloss: 'vectors, dot and cross product, matrices, systems, basis and rank, eigen' },
  { key: 'disc', label: 'Discrete and logic', gloss: 'propositional logic, sets, proof, relations, combinatorics' },
  { key: 'prob', label: 'Probability and statistics', gloss: 'sample spaces, conditional, distributions, descriptive stats' },
  { key: 'geo', label: 'Geometry and trigonometry', gloss: 'plane and solid geometry, Pythagoras, trig ratios, identities, equations' },
  { key: 'vec', label: 'Vector geometry', gloss: 'parametric lines, planes, intersections, distances' },
];
const DOMAIN_LABEL = new Map(DOMAINS.map((d) => [d.key, d.label]));

export function def(id: string): KCDef | undefined {
  return KC_BY_ID.get(id);
}
export function levelOf(id: string): number {
  return KC_BY_ID.get(id)?.level ?? 3;
}
export function labelOf(id: string): string {
  return KC_BY_ID.get(id)?.label ?? id;
}
export function domainOf(id: string): string {
  return KC_BY_ID.get(id)?.domain ?? id.split('.')[0];
}
export function topicOf(id: string): string {
  return KC_BY_ID.get(id)?.topic ?? id.split('.')[1] ?? '';
}
export function domainLabel(key: string): string {
  return DOMAIN_LABEL.get(key) ?? key;
}

// The compact labelled id list, grouped by domain, that follows the assessor
// instructions in the cached system block. Built once at module load so the model
// knows what each id means without us hand-maintaining a second copy.
export const KC_ID_LIST: string = DOMAINS.map((dom) => {
  const rows = KC_DEFS.filter((d) => d.domain === dom.key)
    .map((d) => `${d.id}: ${d.label}`)
    .join('; ');
  return `${dom.key} (${dom.label}; ${dom.gloss}):\n  ${rows}`;
}).join('\n');

// Difficulty exemplar bank (config/exemplars.v1.json): anchor items for the assessor's
// difficulty rating, one median problem per domain and level, authored against the
// which-student-first-reliably-beats-it rule and cross-domain-verified. Rating becomes
// nearest-exemplar MATCHING instead of abstract judgment — the way exam boards
// calibrate raters with anchor items. Levels missing from a domain (calc 1-2, vec 1)
// do not exist under that rule and are deliberately absent.
export interface DifficultyExemplar {
  domain: string;
  level: 1 | 2 | 3 | 4 | 5;
  problem: string;
  whoBeatsIt: string; // rationale, dev-facing only — not sent to the model
}
export const EXEMPLARS = exemplarDefs as DifficultyExemplar[];

const EXEMPLAR_LIST: string = DOMAINS.map((dom) => {
  const rows = EXEMPLARS.filter((e) => e.domain === dom.key)
    .sort((a, b) => a.level - b.level)
    .map((e) => `${e.level}: ${e.problem}`)
    .join('\n  ');
  return `${dom.key}:\n  ${rows}`;
}).join('\n');

// The assessor instructions. Prepended (with KC_ID_LIST) as a constant, cached
// system block before the mode's own grading prompt; see useFeedback. It never
// receives accumulated state, so the prompt is the same size forever.
export const SKILL_ASSESSOR = `You are also a knowledge-component tagger for one math learner, working alongside the grading task described after this block. Tag the atomic math skills the current problem exercises, and (only when grading a finished attempt) how cleanly each was carried out. Tagging is secondary and must never change your grading: do not alter your verdict, and do no extra derivation beyond what grading already requires, just to justify a tag. Grade first, tag second.

Fill "difficulty" and "skills":

- "skills": on an unfinished attempt, the components solving this problem will require; on a finished attempt, the components the learner's OWN written route actually exercised — they may validly solve differently than you would, so tag their ink, not your derivation. Use ids ONLY from the list below; never invent or alter an id; if an exact skill is missing, use the closest listed id only when it genuinely covers the step, otherwise leave it out — a missing observation is cheaper than one filed under the wrong skill. Emit up to 6: any skill tagged "wrong" or "shaky" always makes the list and goes first, then load-bearing core skills, then incidental clean supports.
  - "role": "core" for what the problem is fundamentally about; "support" for atomic skills used incidentally (a sign or fraction step inside a calculus problem). Role is relative to THIS problem, not the skill's domain: in a pure fraction-arithmetic drill, core.arith.fraction-ops IS the core skill.
  - "signal": a finished attempt is a page you are grading CORRECT — every sub-part settled with its own marked final result — including one that turned CORRECT after earlier errors were fixed; whenever the attempt is not finished, emit every skill with "none". Only on a finished attempt: "wrong" only for a genuine mathematical error whose step exercised this skill — a convention-only difference (an absolute value from an even root in a simplification, an unrationalised denominator, a missing domain note, a decimal comma versus point) never makes any skill "wrong"; "shaky" only when the step exercising THIS skill was itself marked falsch, struck through, or redone — self-catching a slip shows the skill working, so it is shaky, not wrong, and a falsch mark on a step exercising a DIFFERENT skill, or a rewrite for neatness or legibility, does not make this skill shaky; "clean" if it was executed with no flagged error. Blame only the skill whose rule or step actually failed at the located error; every other exercised skill keeps its own observed signal — a located sign error tags core.arith.sign-rules "wrong" even if the final answer is now right, while a correctly-executed roots skill in the same problem stays "clean". Absence of an error hint is NOT evidence of clean execution, so leave out any skill you cannot see actually executed rather than calling it clean.
- "difficulty" (1-5) rates the PROBLEM as an opponent: the level of the student who first reliably beats it. RATE BY MATCHING: find the closest exemplar in the DIFFICULTY EXEMPLARS bank below — same domain first, then any domain — and take that exemplar's level; a problem clearly between two exemplars takes the closer one. Stage meaning: 1 = Sek I routine; 2 = Sek II / early-BM routine; 3 = solid BM/FH-entry (the BM median); 4 = Passerelle entrance; 5 = university first-year stretch. Do NOT default to 3; commit to the matched level.

Disambiguation: counting inside a probability computation tags prob.comb.counting; pure combinatorics tags disc.comb.*. A small hand-solved system tags alg.system.linear-small; a matrix or Gaussian system tags la.system.gaussian-elimination.

If you genuinely cannot identify any exercised skill, return "skills": [] — but still rate "difficulty" from the problem itself by exemplar matching.

DIFFICULTY EXEMPLARS (level: a median problem of that level), grouped by domain:
${EXEMPLAR_LIST}

KNOWLEDGE COMPONENTS (id: meaning), grouped by domain:
${KC_ID_LIST}`;

// Dev-time integrity check: the schema enum and the difficulty anchor both depend
// on this staying a complete, well-formed set of 125 leaves.
if (import.meta.env.DEV) {
  if (KC_IDS.length !== 125) console.error(`[nl] kc.v1.json has ${KC_IDS.length} leaves, expected 125`);
  if (KC_SET.size !== KC_IDS.length) console.error('[nl] kc.v1.json has duplicate ids');
  for (const d of KC_DEFS) {
    if (!(d.level >= 1 && d.level <= 5)) console.error(`[nl] ${d.id} has bad level ${d.level}`);
  }
  // Exemplar bank: one anchor per (domain, level), unique problem text (a duplicate
  // anchor poisons nearest-exemplar matching), known domains, prompt-sized lines.
  const slots = new Set<string>();
  const texts = new Set<string>();
  const domKeys = new Set(DOMAINS.map((d) => d.key));
  for (const e of EXEMPLARS) {
    const slot = `${e.domain}:${e.level}`;
    if (slots.has(slot)) console.error(`[nl] exemplars.v1.json duplicate slot ${slot}`);
    slots.add(slot);
    if (texts.has(e.problem)) console.error(`[nl] exemplars.v1.json duplicate problem "${e.problem}"`);
    texts.add(e.problem);
    if (!domKeys.has(e.domain)) console.error(`[nl] exemplar has unknown domain ${e.domain}`);
    if (e.problem.length > 96) console.error(`[nl] exemplar too long: ${slot}`);
  }
}
