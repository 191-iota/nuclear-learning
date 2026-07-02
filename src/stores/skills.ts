import { reactive } from 'vue';
import { settings } from '@/stores/settings';
import {
  KC_SET,
  KC_DEFS,
  DOMAINS,
  levelOf,
  labelOf,
  domainOf,
  topicOf,
} from '@/kc';

/**
 * Skill-mastery estimator. The solve/confirm assessor (see useFeedback) is a stateless
 * sensor: once per solved problem it tags the work against the fixed knowledge-
 * component taxonomy and emits a tiny typed packet. This store is the estimator
 * that turns those packets into a per-skill mastery you can track over time. All
 * of it is cheap local TypeScript, O(1) per observation, so the model prompt never
 * grows and history is free.
 *
 * Per knowledge component we keep a Glicko-style Elo rating: a `theta` (demonstrated
 * ability, logits) updated against the problem's difficulty, a rating deviation `RD`
 * that makes the step size uncertainty-driven and re-opens after idle gaps, an EMA
 * of observed difficulty, success/failure counters, and a memory half-life. The
 * shown number shrinks toward the prior under thin evidence and decays toward chance
 * as a skill goes stale, while `theta` stays sticky for the next update. Domains roll
 * up with a coverage prior, so demonstrating 2 of 18 calculus skills does not light
 * the calculus bar at 95%.
 *
 * Console access:  __nlSkills.summary() · __nlSkills.rankings() · __nlSkills.reset()
 */

export type KCRole = 'core' | 'support';
export type KCSignal = 'clean' | 'shaky' | 'wrong';
// A single observation from the model. `signal` is 'none'/undefined while work is in
// progress (membership only); a real signal arrives when a finished attempt is graded.
export interface KCObservation {
  id: string;
  role: KCRole;
  signal?: KCSignal | 'none';
}
export interface SkillPacket {
  difficulty?: number;
  skills?: KCObservation[];
}

// Durable per-KC state (<=125 records).
export interface KCState {
  theta: number; // demonstrated rating, logits (init 0, or +0.7 for assumed-mastered atoms)
  RD: number; // rating deviation -> drives step size K and the credible interval
  dbar: number; // EMA of observed problem difficulty (init = curriculum level)
  n: number; // observation count -> confidence weight
  s: number; // clean/successful executions
  f: number; // failed executions (+0.5 on a shaky)
  S: number; // memory half-life in days; grows on spaced clean work, halves on a miss
  lastSeen: number; // ms epoch, 0 = never
}

// One daily per-domain snapshot, the source for the mastery-over-time chart.
export interface DomainSnapshot {
  day: number;
  domain: string;
  mastery: number; // 0..1
  cov: number; // coverage 0..1
}

// Global ability: one problem = one observation of a single ability G on the same
// logit scale as per-KC theta. Skills are correlated, so evidence anywhere is evidence
// everywhere — this is the adaptive-testing shortcut that lets placement converge in a
// dozen problems instead of demanding every one of 125 skills be demonstrated twice.
export interface GlobalAbility {
  theta: number; // logits, anchored so 0 = even odds on a BM-median (level 3) problem
  RD: number; // rating deviation, drives step size + the "still settling" display
  n: number; // problems observed
}

export interface SkillStore {
  version: 1;
  kcs: Record<string, KCState>;
  log: DomainSnapshot[];
  diffHist: number[]; // realized observed-difficulty tally [d1..d5], a spread audit
  g: GlobalAbility;
}

// ---- locked constants ----
const D_SLOPE = 0.6; // difficulty is ordinal not interval; lower leverage of a mis-rating
const DIFF_LEVEL_W = 0.6;
const DIFF_DBAR_W = 0.4;
const DIFF_LLM_W = 0.5;
const DIFF_STEP_W = 0.5;
const DBAR_ALPHA = 0.3;
const SUPPORT_D_SHRINK = 0.4;
const SUPPORT_CREDIT = 0.5;
const SHAKY_SCORE = 0.75;
const SHAKY_CREDIT = 0.5;
const RD0 = 1.0;
const RD_MAX = 1.2;
const C_RD = 0.03;
const K_FLOOR = 0.04;
const K_CEIL = 0.8;
const CONF_K0 = 3;
const S0 = 30;
const S_MIN = 7;
const S_MAX = 365;
const FRESH_BASE = 0.5; // R = 0.5^(days/halflife): one half-life per S days
const SPACING_GATE = 0.5;
const W0 = 0.15; // coverage-prior weight per untouched leaf
const SEED_CORE_THETA = 0.7;
const MAXK_CAP = 6;
const MAX_SNAPSHOTS = 1500;
const DAY = 86_400_000;
const EPS = 1e-3;
const KEY = 'nl.skills.v1';

function dTarget(): number {
  const t = (settings.api as { masteryTarget?: number }).masteryTarget;
  return typeof t === 'number' ? t : 0;
}

function sigma(x: number): number {
  return 1 / (1 + Math.exp(-x));
}
function clampInt(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(x)));
}
function stepBucket(k: number): number {
  return k <= 1 ? 1 : k === 2 ? 2 : k <= 4 ? 3 : k <= 6 ? 4 : 5;
}
function obsDiff(llm: number | null, steps: number): number {
  const sb = stepBucket(steps);
  return clampInt(llm != null ? DIFF_LLM_W * llm + DIFF_STEP_W * sb : sb, 1, 5);
}
function credit(role: KCRole): number {
  return role === 'core' ? 1 : SUPPORT_CREDIT;
}
function score(sig: KCSignal): number {
  return sig === 'clean' ? 1 : sig === 'shaky' ? SHAKY_SCORE : 0;
}

// ---- store ----
function freshG(): GlobalAbility {
  return { theta: 0, RD: 1.2, n: 0 };
}

function load(): SkillStore {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const p = JSON.parse(saved) as Partial<SkillStore>;
      if (p && p.kcs && typeof p.kcs === 'object') {
        return {
          version: 1,
          kcs: p.kcs as Record<string, KCState>,
          log: Array.isArray(p.log) ? (p.log as DomainSnapshot[]) : [],
          diffHist:
            Array.isArray(p.diffHist) && p.diffHist.length === 5
              ? (p.diffHist as number[])
              : [0, 0, 0, 0, 0],
          g: p.g && typeof p.g.theta === 'number' ? (p.g as GlobalAbility) : freshG(),
        };
      }
    }
  } catch {
    /* fall through to a fresh store */
  }
  return { version: 1, kcs: {}, log: [], diffHist: [0, 0, 0, 0, 0], g: freshG() };
}

export const skillStore = reactive(load());

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(skillStore));
  } catch {
    /* storage full / unavailable, non-fatal */
  }
}

function materialize(id: string): KCState {
  let kc = skillStore.kcs[id];
  if (!kc) {
    const seeded = id.startsWith('core.arith.') || id.startsWith('core.alg.');
    kc = {
      theta: seeded ? SEED_CORE_THETA : 0,
      RD: RD0,
      dbar: levelOf(id),
      n: 0,
      s: 0,
      f: 0,
      S: S0,
      lastSeen: 0,
    };
    skillStore.kcs[id] = kc;
  }
  return kc;
}

// One uncertainty-driven Elo step for a single knowledge component.
function eloUpdate(o: KCObservation, sig: KCSignal, od: number, blameScale: number, now: number): void {
  const kc = materialize(o.id);
  const dDays = kc.lastSeen ? (now - kc.lastSeen) / DAY : 0;
  // Pre-inflate RD for the idle gap so a long-unpracticed skill becomes plastic again.
  kc.RD = Math.min(RD_MAX, Math.sqrt(kc.RD * kc.RD + C_RD * C_RD * dDays));
  // Difficulty anchor: blend the skill's curriculum level with the running average of
  // observed difficulty (which itself blends the model rating with an objective step count).
  kc.dbar = (1 - DBAR_ALPHA) * kc.dbar + DBAR_ALPHA * od;
  const effDiff = clampInt(DIFF_LEVEL_W * levelOf(o.id) + DIFF_DBAR_W * kc.dbar, 1, 5);
  const dItem = (effDiff - 3) * D_SLOPE;
  const dEff = o.role === 'core' ? dItem : SUPPORT_D_SHRINK * dItem;
  const E = sigma(kc.theta - dEff);
  const K = Math.max(K_FLOOR, Math.min(K_CEIL, kc.RD * kc.RD));
  const sc = score(sig);
  const creditEff =
    credit(o.role) * (sig === 'shaky' ? SHAKY_CREDIT : 1) * (sig === 'wrong' ? blameScale : 1);
  kc.theta += creditEff * K * (sc - E);
  // Shrink RD by the Fisher information this observation carried.
  kc.RD = Math.sqrt(1 / (1 / (kc.RD * kc.RD) + Math.max(EPS, E * (1 - E))));
  kc.n += 1;
  if (sc >= 0.75) kc.s += 1;
  else if (sc <= 0.25) kc.f += 1;
  if (sig === 'shaky') kc.f += 0.5;
  // Stability (memory half-life): spaced clean work lengthens it; a miss halves it.
  if (sig === 'clean' && dDays >= SPACING_GATE * kc.S) kc.S = Math.min(S_MAX, kc.S * 1.8);
  else if (sig === 'wrong') kc.S = Math.max(S_MIN, kc.S * 0.5);
  kc.lastSeen = now;
}

function signalRank(sig: KCObservation['signal']): number {
  return sig === 'wrong' ? 3 : sig === 'shaky' ? 2 : sig === 'clean' ? 1 : 0;
}

// Fold one solved-problem packet into the estimator. Order matters: filter to valid
// ids, dedupe keeping the worst signal, sort most-informative first, then cap, so any
// dropped observation is the least informative.
export function applySkillPacket(packet: SkillPacket, steps: number, now: number): void {
  if (!settings.api.trackSkills) return;
  const raw = packet.skills ?? [];
  if (!raw.length) return;

  const byId = new Map<string, KCObservation>();
  for (const o of raw) {
    if (!o || !KC_SET.has(o.id) || (o.role !== 'core' && o.role !== 'support')) continue;
    const prev = byId.get(o.id);
    if (!prev || signalRank(o.signal) > signalRank(prev.signal)) byId.set(o.id, o);
  }
  const signed = [...byId.values()].filter(
    (o) => o.signal === 'clean' || o.signal === 'shaky' || o.signal === 'wrong',
  );
  if (!signed.length) return;

  signed.sort((a, b) => {
    const ra = a.role === 'core' ? 1 : 0;
    const rb = b.role === 'core' ? 1 : 0;
    if (ra !== rb) return rb - ra;
    return signalRank(b.signal) - signalRank(a.signal);
  });
  const maxK = Math.min(MAXK_CAP, (packet.difficulty != null ? clampInt(packet.difficulty, 1, 5) : 3) + 2);
  const use = signed.slice(0, maxK);

  const od = obsDiff(packet.difficulty != null ? packet.difficulty : null, steps);
  skillStore.diffHist[od - 1] += 1;

  // Cap total negative credit across simultaneously-wrong KCs so one ambiguous error
  // cannot tank several skills.
  const wrongCredit = use
    .filter((o) => o.signal === 'wrong')
    .reduce((a, o) => a + credit(o.role), 0);
  const blameScale = 1 / Math.max(1, wrongCredit);

  for (const o of use) eloUpdate(o, o.signal as KCSignal, od, blameScale, now);

  // Global ability: this problem is ONE observation of G — the mean signal of ALL
  // validated observations (`signed`, before the per-KC maxK truncation, whose
  // worst-first ordering would bias a mean) at the observed difficulty. Uncertainty-
  // driven step, floored RD so late problems still move it a little; no time decay
  // (ability does not evaporate in days the way recall does). Two asymmetries on
  // purpose: a clean solve the estimate already expected (E >= .85) is confirmation,
  // not information — no upward push, so grinding easy problems cannot farm the
  // placement — while a miss at that same easy difficulty still counts but is damped
  // by its Fisher information, so routine slips and abandoned pages erode a strong
  // estimate slowly instead of ratcheting it away with no recovery path.
  const gSc = signed.reduce((a, o) => a + score(o.signal as KCSignal), 0) / signed.length;
  const g = skillStore.g;
  const gE = sigma(g.theta - (od - 3) * D_SLOPE);
  if (!(gSc >= gE && gE >= 0.85)) {
    const gK = Math.min(0.35, g.RD * g.RD);
    const damp = gSc < gE && gE >= 0.85 ? 4 * gE * (1 - gE) : 1;
    g.theta += gK * damp * (gSc - gE);
    g.RD = Math.max(0.25, Math.sqrt(1 / (1 / (g.RD * g.RD) + Math.max(EPS, gE * (1 - gE)))));
  }
  g.n += 1;

  upsertSnapshots(use, now);
  persist();
}

// ---- placement: where the global ability sits on the Swiss school ladder ----

// The level at which the learner would solve about 3 problems in 4 — the working
// frontier, continuous on the 1..5 curriculum scale.
const PLACE_SUCCESS_MARGIN = 1.1; // logit margin for ~75% success
const INFER_N0 = 8; // problems until inference carries half weight

export interface Placement {
  level: number; // continuous 1..5, clamped
  n: number; // problems behind the estimate
  settled: boolean; // enough evidence to show a marker
}

export function placement(): Placement | null {
  const g = skillStore.g;
  if (g.n === 0) return null;
  const level = Math.min(5, Math.max(1, 3 + (g.theta - PLACE_SUCCESS_MARGIN) / D_SLOPE));
  return { level, n: g.n, settled: g.n >= 5 };
}

// P(an untouched skill at this curriculum level is already held), inferred from the
// global ability and gated by how much evidence backs it — 0 with no data, so band
// fills start honest and grow as the estimate firms up.
export function inferredMastery(kcLevel: number): number {
  const g = skillStore.g;
  if (g.n === 0) return 0;
  const iw = g.n / (g.n + INFER_N0);
  const margin = g.theta - PLACE_SUCCESS_MARGIN - (kcLevel - 3) * D_SLOPE;
  return iw * sigma(margin / 0.5);
}

// ---- display (computed on read; theta and RD stay sticky internally) ----
function confWeight(n: number): number {
  return n / (n + CONF_K0);
}
function retrievability(kc: KCState, now: number): number {
  return kc.lastSeen ? Math.pow(FRESH_BASE, (now - kc.lastSeen) / DAY / kc.S) : 1;
}
function masteryFrac(kc: KCState, now: number): number {
  const cw = confWeight(kc.n);
  const R = retrievability(kc, now);
  return 0.5 + (sigma((kc.theta - dTarget()) * cw) - 0.5) * R;
}

export interface KCView {
  id: string;
  label: string;
  domain: string;
  topic: string;
  masteryPct: number;
  n: number;
  R: number;
  daysSince: number;
  fresh: boolean;
  f: number;
  provisional: boolean;
}

export function kcView(now = Date.now()): KCView[] {
  const out: KCView[] = [];
  for (const id of Object.keys(skillStore.kcs)) {
    const kc = skillStore.kcs[id];
    if (kc.n <= 0) continue;
    const R = retrievability(kc, now);
    out.push({
      id,
      label: labelOf(id),
      domain: domainOf(id),
      topic: topicOf(id),
      masteryPct: Math.round(100 * masteryFrac(kc, now)),
      n: kc.n,
      R,
      daysSince: kc.lastSeen ? Math.floor((now - kc.lastSeen) / DAY) : 0,
      fresh: R >= 0.7,
      f: Math.round(kc.f),
      provisional: kc.n < 3,
    });
  }
  return out;
}

export interface DomainRollup {
  domain: string;
  label: string;
  masteryPct: number | null; // null = not assessed (coverage 0)
  coverage: number;
  touched: number;
  total: number;
}

export function domainRollup(now = Date.now()): DomainRollup[] {
  return DOMAINS.map((dom) => {
    const leaves = KC_DEFS.filter((d) => d.domain === dom.key);
    let num = 0;
    let den = 0;
    let touched = 0;
    let untouched = 0;
    for (const d of leaves) {
      const kc = skillStore.kcs[d.id];
      if (kc && kc.n > 0) {
        const cw = confWeight(kc.n);
        num += masteryFrac(kc, now) * cw;
        den += cw;
        touched += 1;
      } else {
        untouched += 1;
      }
    }
    num += 0.5 * W0 * untouched;
    den += W0 * untouched;
    const mastery = touched === 0 ? null : num / den;
    return {
      domain: dom.key,
      label: dom.label,
      masteryPct: mastery === null ? null : Math.round(100 * mastery),
      coverage: leaves.length ? touched / leaves.length : 0,
      touched,
      total: leaves.length,
    };
  });
}

export function topicRollup(domain: string, now = Date.now()) {
  const topics = [...new Set(KC_DEFS.filter((d) => d.domain === domain).map((d) => d.topic))];
  return topics
    .map((topic) => {
      const leaves = KC_DEFS.filter((d) => d.domain === domain && d.topic === topic);
      let num = 0;
      let den = 0;
      let touched = 0;
      let untouched = 0;
      for (const d of leaves) {
        const kc = skillStore.kcs[d.id];
        if (kc && kc.n > 0) {
          const cw = confWeight(kc.n);
          num += masteryFrac(kc, now) * cw;
          den += cw;
          touched += 1;
        } else untouched += 1;
      }
      num += 0.5 * W0 * untouched;
      den += W0 * untouched;
      return {
        topic,
        masteryPct: touched === 0 ? null : Math.round(100 * (num / den)),
        touched,
        total: leaves.length,
      };
    })
    .filter((t) => t.touched > 0);
}

export interface RankRow extends KCView {
  score: number;
}

function ranked(metric: (kc: KCState, v: KCView, now: number) => number, minN: number, now: number): RankRow[] {
  const rows: RankRow[] = [];
  for (const v of kcView(now)) {
    const kc = skillStore.kcs[v.id];
    if (kc.n < minN) continue;
    rows.push({ ...v, score: metric(kc, v, now) });
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, 8);
}

export function rankings(now = Date.now()) {
  const cw = (kc: KCState) => confWeight(kc.n);
  return {
    // Genuinely weak skills (low display mastery), lightly tie-broken by staleness.
    drill: ranked((kc, v) => (1 - v.masteryPct / 100) * cw(kc) * (0.7 + 0.3 * (1 - v.R)), 2, now),
    // Strong but going stale, the refresh list.
    fading: ranked((kc, v) => (v.masteryPct / 100) * (1 - v.R) * cw(kc), 2, now),
    // Confident strengths.
    strongest: ranked((kc, v) => (v.masteryPct / 100) * cw(kc), 3, now),
  };
}

export interface PracticeRec {
  drill: RankRow | null; // weakest touched skill worth practising now (learn / strengthen)
  review: RankRow | null; // strongest skill going stale, worth a refresh before it fades
}

// Turn the mastery estimate into an actual recommendation of what to practise next. `drill` is the
// weakest skill you have touched, `review` the strongest one going stale. This is the thin
// controller that makes the estimator STEER rather than only report. (A prerequisite ordering would
// later refine "weakest" into "weakest you are ready for"; that DAG does not exist yet.)
export function recommendPractice(now = Date.now()): PracticeRec {
  const r = rankings(now);
  return { drill: r.drill[0] ?? null, review: r.fading[0] ?? null };
}

export function skillSummary(now = Date.now()) {
  const dom = domainRollup(now);
  const touchedDomains = dom.filter((d) => d.touched > 0);
  const coveredKCs = Object.values(skillStore.kcs).filter((k) => k.n > 0).length;
  const ranked2 = [...touchedDomains].sort((a, b) => (a.masteryPct ?? 0) - (b.masteryPct ?? 0));
  let rusty = 0;
  for (const id of Object.keys(skillStore.kcs)) {
    const kc = skillStore.kcs[id];
    if (kc.n <= 0) continue;
    if (sigma((kc.theta - dTarget()) * confWeight(kc.n)) >= 0.6 && retrievability(kc, now) < 0.6) rusty += 1;
  }
  return {
    coveredKCs,
    totalKCs: KC_DEFS.length,
    domainsTouched: touchedDomains.length,
    totalDomains: DOMAINS.length,
    weakest: ranked2[0] ?? null,
    strongest: ranked2.length ? ranked2[ranked2.length - 1] : null,
    rusty,
  };
}

export function trajectory(domain: string, now = Date.now()) {
  const rows = skillStore.log.filter((r) => r.domain === domain).sort((a, b) => a.day - b.day);
  if (rows.length < 2) return [] as { day: number; masteryPct: number; cov: number }[];
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const firstDay = rows[0].day;
  const today = Math.floor(now / DAY);
  const out: { day: number; masteryPct: number; cov: number }[] = [];
  let last = rows[0];
  for (let day = firstDay; day <= today; day += 1) {
    const r = byDay.get(day);
    if (r) last = r;
    out.push({ day, masteryPct: Math.round(100 * last.mastery), cov: last.cov });
  }
  return out;
}

// Overall mastery trajectory: every touched domain's daily snapshot forward-filled,
// then averaged into one line. Pure read over skillStore.log — no rating logic, just the
// per-domain snapshots the estimator already writes, aggregated the same way the bar
// chart shows them (equal weight per touched domain).
export function overallTrajectory(now = Date.now()) {
  const log = skillStore.log;
  if (log.length < 2) return [] as { day: number; masteryPct: number; cov: number }[];
  const byDomain = new Map<string, Map<number, DomainSnapshot>>();
  let firstDay = Infinity;
  for (const r of log) {
    let days = byDomain.get(r.domain);
    if (!days) byDomain.set(r.domain, (days = new Map()));
    days.set(r.day, r);
    if (r.day < firstDay) firstDay = r.day;
  }
  const today = Math.floor(now / DAY);
  const last = new Map<string, DomainSnapshot>(); // forward-filled per domain
  const out: { day: number; masteryPct: number; cov: number }[] = [];
  for (let day = firstDay; day <= today; day += 1) {
    for (const [dom, days] of byDomain) {
      const r = days.get(day);
      if (r) last.set(dom, r);
    }
    let m = 0;
    let c = 0;
    for (const r of last.values()) {
      m += r.mastery;
      c += r.cov;
    }
    const k = last.size;
    if (k > 0) out.push({ day, masteryPct: Math.round((100 * m) / k), cov: c / k });
  }
  return out.length >= 2 ? out : [];
}

function upsertSnapshots(obs: KCObservation[], now: number): void {
  const day = Math.floor(now / DAY);
  const domains = new Set(obs.map((o) => domainOf(o.id)));
  const roll = domainRollup(now);
  for (const dkey of domains) {
    const dr = roll.find((r) => r.domain === dkey);
    if (!dr || dr.masteryPct === null) continue;
    const existing = skillStore.log.find((r) => r.day === day && r.domain === dkey);
    if (existing) {
      existing.mastery = dr.masteryPct / 100;
      existing.cov = dr.coverage;
    } else {
      skillStore.log.push({ day, domain: dkey, mastery: dr.masteryPct / 100, cov: dr.coverage });
    }
  }
  // Evict whole oldest days (not single rows) so a day's domains stay together.
  while (skillStore.log.length > MAX_SNAPSHOTS) {
    let oldest = Infinity;
    for (const r of skillStore.log) if (r.day < oldest) oldest = r.day;
    for (let i = skillStore.log.length - 1; i >= 0; i -= 1) if (skillStore.log[i].day === oldest) skillStore.log.splice(i, 1);
  }
}

export function resetSkills(): void {
  for (const k of Object.keys(skillStore.kcs)) delete skillStore.kcs[k];
  skillStore.log.splice(0, skillStore.log.length);
  skillStore.diffHist.splice(0, skillStore.diffHist.length, 0, 0, 0, 0, 0);
  Object.assign(skillStore.g, freshG());
  persist();
}

if (typeof window !== 'undefined') {
  (window as unknown as { __nlSkills: unknown }).__nlSkills = {
    all: () => skillStore.kcs,
    domains: () => domainRollup(),
    rankings: () => rankings(),
    recommend: () => recommendPractice(),
    trajectory: (d: string) => trajectory(d),
    overall: () => overallTrajectory(),
    summary: () => skillSummary(),
    diffHist: () => skillStore.diffHist.slice(),
    reset: resetSkills,
  };
}
