import OpenAI from 'openai';
import { recordUsage } from '@/stores/usage';
import { labelOf, levelOf } from '@/kc';

/**
 * Generates ONE practice problem targeted at a weak skill, on demand. This closes the
 * progression loop: the estimator knows the weakest skill and the ideal difficulty
 * (about 4-in-5 success, hard enough to stretch, not to stall — the deliberate-practice
 * band), but until now it could only NAME the skill; the learner still had to go find a
 * matching problem. One cheap text-only gpt-5.4-mini call turns the recommendation into an
 * actual problem to copy onto paper, where the normal grading loop takes over.
 */
const DRILL_MODEL = 'gpt-5.4-mini';

const DRILL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['problem', 'task'],
  properties: {
    problem: { type: 'string' },
    task: { type: 'string' },
  },
};

const SYSTEM = `You write ONE practice problem for a Swiss mathematics learner on the BM → Passerelle → university track, targeting one named skill at a stated mastery level. Difficulty language: level 1-2 skills are Sek/early-BM routine, level 3 is the BM/FH core, level 4 is Passerelle entrance, level 5 is university first-year stretch.

Return JSON {task, problem}:
- "task": the instruction verb line, in German (Swiss Hochdeutsch, "ss" not "ß"), e.g. "Vereinfache:", "Löse nach x auf:", "Bestimme die Lösungsmenge:".
- "problem": the bare mathematical statement to work on, ALL math in LaTeX between single $ delimiters.

Difficulty: aim for a problem the learner solves correctly about 4 times in 5 — one notch above comfortable. Below 40% mastery, write a clean single-concept problem of the skill; 40-70%, a routine problem with one twist (a sign, a fraction, a parameter); above 70%, combine the skill with one natural neighbour skill or add a step. Numbers must work out cleanly by hand (no calculator artifacts), the problem must be self-contained, and it must genuinely exercise the named skill — not merely mention it. Never include the solution, hints, or an answer blank.`;

let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) {
    const apiKey = import.meta.env.VITE_OPENAI_API_KEY;
    if (!apiKey) throw new Error('Missing VITE_OPENAI_API_KEY.');
    client = new OpenAI({ apiKey, dangerouslyAllowBrowser: true, timeout: 60000, maxRetries: 1 });
  }
  return client;
}

export interface DrillProblem {
  task: string;
  problem: string;
  skillLabel: string;
}

export async function generateDrill(skillId: string, masteryPct: number): Promise<DrillProblem | null> {
  try {
    const label = labelOf(skillId);
    const user = [
      `Skill: ${label} (id ${skillId}, curriculum level ${levelOf(skillId)} of 5).`,
      `Learner mastery of this skill right now: ${masteryPct}%.`,
      'Write the problem.',
    ].join('\n');
    const resp = await getClient().chat.completions.create({
      model: DRILL_MODEL,
      max_completion_tokens: 2000,
      reasoning_effort: 'medium',
      messages: [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: user },
      ],
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'drill', strict: true, schema: DRILL_SCHEMA },
      },
    } as any);
    const u = (resp as any)?.usage ?? {};
    recordUsage({
      mode: 'drill',
      model: DRILL_MODEL,
      role: 'drill',
      input: u.prompt_tokens ?? 0,
      output: u.completion_tokens ?? 0,
      cacheRead: u.prompt_tokens_details?.cached_tokens ?? 0,
      cacheCreate: 0,
    });
    const out = (resp.choices?.[0]?.message?.content ?? '').trim();
    const p = JSON.parse(out) as { task?: string; problem?: string };
    const task = (p.task ?? '').trim();
    const problem = (p.problem ?? '').trim();
    if (!problem) return null;
    return { task, problem, skillLabel: label };
  } catch (err) {
    console.warn('[nuclear-learning] drill generation failed:', err);
    return null;
  }
}
