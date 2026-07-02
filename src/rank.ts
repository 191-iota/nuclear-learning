import { KC_DEFS } from '@/kc';
import { kcView, placement, inferredMastery, type Placement } from '@/stores/skills';

/**
 * Rank system: one ladder of six ranks anchored to the Swiss school progression.
 *
 * The anchor is free data the app already has: every knowledge component carries a
 * curriculum level (1-2 Sek, 3 BM/FH core, 4 Passerelle, 5 university stretch), and the
 * estimator keeps a decay-aware mastery per component plus one GLOBAL ability updated by
 * every solved problem. Band fill is EXPECTED mastery mass, three ingredients:
 *   - a SECURED component (>= 70% shown mastery on n >= 2) counts fully;
 *   - a touched-but-unsecured component counts partially by its own mastery;
 *   - an untouched component counts by what the global ability predicts for its level,
 *     capped so inference can start a band but never finish it — placement is fast,
 *     securing is earned.
 * Because mastery decays as skills go stale, ranks can decay too: held, not owned.
 */

export const SECURE_PCT = 70;
export const SECURE_MIN_N = 2;
// A touched-but-unsecured skill earns partial credit on this ramp of its mastery.
const PARTIAL_LO = 40;
const PARTIAL_CAP = 0.8;
// Inference (from the global ability) contributes at most half of any band.
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

interface Gate {
  band: string;
  pct: number;
}

export interface RankDef {
  n: number; // 1..6
  title: string;
  anchor: string; // what holding this rank means, in plain academic terms
  gates: Gate[];
}

export const RANKS: RankDef[] = [
  { n: 1, title: 'Apprentice', anchor: 'first skills tracked', gates: [] },
  { n: 2, title: 'Artisan', anchor: 'Sek foundations solid', gates: [{ band: 'sek', pct: 60 }] },
  {
    n: 3,
    title: 'Operator',
    anchor: 'BM/FH core in hand',
    gates: [
      { band: 'sek', pct: 70 },
      { band: 'bm', pct: 40 },
    ],
  },
  {
    n: 4,
    title: 'Vanguard',
    anchor: 'Passerelle band opening',
    gates: [
      { band: 'bm', pct: 70 },
      { band: 'pas', pct: 30 },
    ],
  },
  {
    n: 5,
    title: 'Master',
    anchor: 'Passerelle secured, uni stretch underway',
    gates: [
      { band: 'bm', pct: 85 },
      { band: 'pas', pct: 60 },
      { band: 'uni', pct: 25 },
    ],
  },
  {
    n: 6,
    title: 'Grandmaster',
    anchor: 'uni-ready across the map',
    gates: [
      { band: 'pas', pct: 80 },
      { band: 'uni', pct: 60 },
    ],
  },
];

export interface BandStat {
  key: string;
  label: string;
  short: string;
  secured: number; // directly secured count
  total: number;
  fill: number; // expected mastery mass, 0..total (drives gates and the bars)
  pct: number; // rounded display percent of fill
}

export interface RankView {
  rank: RankDef;
  next: RankDef | null;
  bands: BandStat[];
  place: Placement | null;
  nextProgress: number; // 0..100 toward the least-satisfied gate of the next rank
  nextStep: string; // plain-language bottleneck line
  nextBand: string | null; // band key of the bottleneck, the drill target band
}

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
          // Monotone under probing: a touched-but-unsecured skill is never worth LESS
          // than it was as an untouched inference — the excess above the partial ramp
          // stays routed through the capped inference pool, so probing a skill (the
          // Drill button's whole point) can only move the gate forward.
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
      fill,
      pct: members.length ? Math.round((100 * fill) / members.length) : 0,
    };
  });
}

// Compare on the exact fraction, not the display-rounded pct, so the "about N more"
// arithmetic in nextStep can never disagree with the gate itself.
function gateHolds(g: Gate, bands: BandStat[]): boolean {
  const b = bands.find((x) => x.key === g.band);
  return !!b && 100 * b.fill >= g.pct * b.total;
}

export function rankView(now = Date.now()): RankView {
  const bands = bandStats(now);
  let held = RANKS[0];
  for (const r of RANKS) {
    if (r.gates.every((g) => gateHolds(g, bands))) held = r;
    else break; // ranks are strictly ordered; the first failed rank ends the climb
  }
  const next = RANKS.find((r) => r.n === held.n + 1) ?? null;

  let nextProgress = 100;
  let nextStep = '';
  let nextBand: string | null = null;
  if (next) {
    let worst = 1;
    let worstGate: Gate | null = null;
    for (const g of next.gates) {
      const b = bands.find((x) => x.key === g.band);
      const frac = b ? Math.min(1, (100 * b.fill) / (g.pct * b.total)) : 0;
      if (worstGate === null || frac < worst) {
        worst = frac;
        worstGate = g;
      }
    }
    nextProgress = Math.round(100 * worst);
    if (worstGate) {
      const b = bands.find((x) => x.key === worstGate!.band)!;
      nextBand = b.key;
      const need = Math.max(0, Math.ceil((worstGate.pct / 100) * b.total - b.fill));
      nextStep =
        need > 0
          ? `about ${need} more ${b.label} skill${need === 1 ? '' : 's'}`
          : 'hold your secured skills against decay';
    }
  }
  return { rank: held, next, bands, place: placement(), nextProgress, nextStep, nextBand };
}

// The skill to drill for rank progress: an untouched component in the bottleneck band
// (probing it both places you faster and fills the gate), else its weakest touched one.
export function rankDrillTarget(now = Date.now()): { id: string; masteryPct: number; label: string } | null {
  const rv = rankView(now);
  const bandKey = rv.nextBand;
  const band = BANDS.find((b) => b.key === bandKey);
  if (!band) return null;
  const members = KC_DEFS.filter((d) => band.levels.includes(d.level));
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
