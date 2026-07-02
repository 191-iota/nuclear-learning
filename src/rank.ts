import { KC_DEFS } from '@/kc';
import {
  kcView,
  placement,
  rating,
  inferredMastery,
  type Placement,
  type Rating,
} from '@/stores/skills';

/**
 * Rank system, chess-style: you solve problems, the problems' difficulty is the
 * opponent's strength, and the resulting RATING is the one number that says where you
 * stand. A rank is nothing but the label on a rating band — like 2500 reading
 * "grandmaster" — so it arrives after a handful of problems, climbs (and falls) with
 * the curve, and never asks you to grind out coverage.
 *
 * The scale is anchored to the Swiss school ladder through the problem difficulties
 * the assessor already rates (1-2 Sek, 3 BM/FH median, 4 Passerelle, 5 uni stretch):
 * 400 rating points per curriculum level, 1600 = solid at the BM median. Climbing past
 * a band therefore requires beating problems of the next band — grinding easy material
 * cannot farm the rating (confirmation cap in the estimator).
 *
 * The per-skill map (secured skills, decay, domain mastery) stays as the DIAGNOSTIC
 * layer that steers what to drill; it no longer gates the rank.
 */

export const SECURE_PCT = 70;
export const SECURE_MIN_N = 2;
const PARTIAL_LO = 40;
const PARTIAL_CAP = 0.8;
const INFER_BAND_CAP = 0.5;
const INFER_KC_CAP = 0.8;

export interface StageBand {
  key: string;
  label: string;
  short: string;
  levels: number[];
}
export const BANDS: StageBand[] = [
  { key: 'sek', label: 'Sek level', short: 'Sek', levels: [1, 2] },
  { key: 'bm', label: 'BM/FH core', short: 'BM', levels: [3] },
  { key: 'pas', label: 'Passerelle band', short: 'Passerelle', levels: [4] },
  { key: 'uni', label: 'Uni stretch', short: 'Uni', levels: [5] },
];

export interface RankDef {
  n: number; // 1..6
  title: string;
  anchor: string; // what the band means, in plain academic terms
  minRating: number;
}

// Rank = the student identity whose IN-PROGRAM math level you perform at (not merely
// whose admission you'd clear — that keeps the ordering strict where routes overlap).
// The placements are source-grounded, not vibes:
// - HF sits BELOW BM: HF admission runs on an EFZ + work experience with no BM (only
//   ~10% of HF entrants hold one, BFS 2020), the math is applied and per-school, and
//   the FHNW's own Vorkurs page judges completed-HF math "oft deutlich unter dem
//   Niveau der technischen Berufsmatur".
// - BM math (RLP 2025) is functions, equations, vector geometry, stochastics — no
//   calculus; first real Analysis is FH year 1, and FH ENTRY is BM level by design.
// - Strong FH ≈ Passerelle-pass-capable ≈ ETH-entry-equivalent (~2000): ETH prices a
//   top FH bachelor at 40-60 ECTS of catch-up. ETH Student means surviving the
//   math-weighted Basisjahr, which 35-50% of admitted students fail — so entry and
//   survival are distinct rungs.
// The first rank starts at the rating floor (ratings clamp at 400), so the progress
// bar through the band starts empty.
export const RANKS: RankDef[] = [
  { n: 1, title: 'Sek Student', anchor: 'Sek-level algebra and geometry taking shape', minRating: 400 },
  { n: 2, title: 'HF Student', anchor: 'applied, job-anchored math — algebra, linear systems, functions from the graph', minRating: 1150 },
  { n: 3, title: 'BM Student', anchor: 'the BM core: functions, equations, vector geometry, stochastics', minRating: 1500 },
  { n: 4, title: 'FH Student', anchor: 'functioning in applied first-year Analysis and lineare Algebra', minRating: 1700 },
  { n: 5, title: 'Strong FH Student', anchor: 'top of the FH cohort — Passerelle-pass capable', minRating: 1950 },
  { n: 6, title: 'ETH Student', anchor: 'surviving a math-weighted Basisjahr', minRating: 2150 },
  { n: 7, title: 'Strong ETH Student', anchor: 'clearing the Basisprüfung with room to spare', minRating: 2300 },
  { n: 8, title: 'Transcendent', anchor: 'beyond the ladder', minRating: 2400 },
];

export function rankForRating(r: number): RankDef {
  let held = RANKS[0];
  for (const def of RANKS) if (r >= def.minRating) held = def;
  return held;
}

export interface BandStat {
  key: string;
  label: string;
  short: string;
  secured: number; // directly secured count
  total: number;
  pct: number; // expected mastery mass, rounded display percent
}

export interface RankView {
  rank: RankDef;
  next: RankDef | null;
  rating: Rating | null;
  bands: BandStat[];
  place: Placement | null;
  nextProgress: number; // 0..100 through the current rating band
  nextStep: string; // plain-language line toward the next rank
}

// The skill-map fills for the axis: expected mastery mass per band (secured = 1,
// touched-partial on a ramp, untouched = capped inference — monotone under probing).
// Diagnostic only; the rank no longer gates on this.
function bandStats(now: number): BandStat[] {
  const views = new Map(kcView(now).map((v) => [v.id, v]));
  return BANDS.map((b) => {
    const members = KC_DEFS.filter((d) => b.levels.includes(d.level));
    let direct = 0;
    let inferred = 0;
    let secured = 0;
    for (const d of members) {
      const v = views.get(d.id);
      const infer = Math.min(INFER_KC_CAP, inferredMastery(d.level));
      if (v) {
        if (v.masteryPct >= SECURE_PCT && v.n >= SECURE_MIN_N) {
          secured += 1;
          direct += 1;
        } else {
          const partial = Math.min(
            PARTIAL_CAP,
            Math.max(0, (v.masteryPct - PARTIAL_LO) / (100 - PARTIAL_LO)),
          );
          direct += partial;
          inferred += Math.max(0, infer - partial);
        }
      } else {
        inferred += infer;
      }
    }
    const fill = Math.min(members.length, direct + Math.min(inferred, INFER_BAND_CAP * members.length));
    return {
      key: b.key,
      label: b.label,
      short: b.short,
      secured,
      total: members.length,
      pct: members.length ? Math.round((100 * fill) / members.length) : 0,
    };
  });
}

export function rankView(now = Date.now()): RankView {
  const r = rating(now);
  const bands = bandStats(now);
  const held = rankForRating(r?.value ?? 0);
  const next = RANKS.find((d) => d.n === held.n + 1) ?? null;

  let nextProgress = 0;
  let nextStep = '';
  if (r && next) {
    const span = next.minRating - held.minRating;
    nextProgress = Math.round(
      (100 * Math.min(span, Math.max(0, r.value - held.minRating))) / span,
    );
    nextStep = `${next.minRating - r.value} rating to go — beat problems at your level or above`;
  } else if (!r && next) {
    nextStep = 'solve a few problems to get rated';
  }
  return { rank: held, next, rating: r, bands, place: placement(), nextProgress, nextStep };
}

// The skill to drill for rating progress: a weak-or-unshown skill in the band at the
// learner's working frontier (the placement level, rounded up — beating problems at or
// above your level is what moves the rating). Falls back to the BM band unplaced.
export function rankDrillTarget(now = Date.now()): { id: string; masteryPct: number; label: string } | null {
  const p = placement();
  const frontier = p ? Math.min(5, Math.max(1, Math.ceil(p.level))) : 3;
  const band = BANDS.find((b) => b.levels.includes(frontier)) ?? BANDS[1];
  const members = KC_DEFS.filter((d) => band.levels.includes(d.level));
  if (!members.length) return null;
  const views = new Map(kcView(now).map((v) => [v.id, v]));
  const untouched = members.filter((d) => !views.has(d.id));
  if (untouched.length) {
    const pick = untouched[Math.floor(Math.random() * untouched.length)];
    return { id: pick.id, masteryPct: 0, label: pick.label };
  }
  let weakest: { id: string; masteryPct: number; label: string } | null = null;
  for (const d of members) {
    const v = views.get(d.id);
    if (v && (!weakest || v.masteryPct < weakest.masteryPct)) {
      weakest = { id: d.id, masteryPct: v.masteryPct, label: d.label };
    }
  }
  return weakest;
}
