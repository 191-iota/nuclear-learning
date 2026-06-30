import kcDefs from '@config/kc.v1.json';

/**
 * The fixed knowledge-component taxonomy (config/kc.v1.json). This is the closed
 * vocabulary the Opus assessor tags handwritten work against: 125 immutable leaf
 * skills across 11 domains, depth-3 slug `domain.topic.skill`.
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

// The assessor instructions. Prepended (with KC_ID_LIST) as a constant, cached
// system block before the mode's own grading prompt; see useFeedback. It never
// receives accumulated state, so the prompt is the same size forever.
export const SKILL_ASSESSOR = `You are also a knowledge-component tagger for one math learner, working alongside the grading task described after this block. Tag the atomic math skills the current problem exercises, and (only when grading a finished attempt) how cleanly each was carried out. Do not solve, re-derive, or change your grading verdict because of this task. Grade first, tag second.

Fill "difficulty" and "skills":

- "skills": the knowledge components this problem actually uses. Use ids ONLY from the list below; never invent or alter an id; if an exact skill is missing, pick the closest listed id or leave it out. Emit up to 6, the load-bearing core skills first and incidental supports last.
  - "role": "core" for what the problem is fundamentally about; "support" for atomic skills used incidentally (a sign or fraction step inside a calculus problem).
  - "signal": "none" while the work is still in progress, or whenever you are not grading a finished attempt, emit the skill with "none". Only on a finished attempt: "wrong" if a located error on this page implicates this skill; "shaky" if it was executed but with a visible self-correction, crossing-out, or rewrite; "clean" if it was executed with no flagged error. Absence of an error hint is NOT evidence of clean execution, so leave out any skill you cannot see actually executed rather than calling it clean. A located sign error tags core.arith.sign-rules "wrong" even if the final answer is now right.
- "difficulty" (1-5) rates the PROBLEM, anchored to this curriculum: 1 trivial single step; 2 routine one concept; 3 solid multi-step (BM/HF median); 4 demanding, several concepts combined; 5 Passerelle/ETH stretch or genuinely novel. Do NOT default to 3; push toward 1-2 or 4-5 whenever warranted. Examples: 2x+3=11 is 1; factor x^2+5x+6 is 2; optimize a fenced area with calculus is 3; solve a separable ODE with an initial condition is 4; classify the intersection of two planes given parametrically is 5.

Disambiguation: counting inside a probability computation tags prob.comb.counting; pure combinatorics tags disc.comb.*. A small hand-solved system tags alg.system.linear-small; a matrix or Gaussian system tags la.system.gaussian-elimination.

If you genuinely cannot identify any exercised skill, return "skills": [] and "difficulty": 3.

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
}
