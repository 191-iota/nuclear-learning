import { reactive } from 'vue';
import { settings } from '@/stores/settings';
import { logEvent } from '@/stores/obslog';
import { KC_SET, KC_DEFS, DOMAINS, labelOf, domainOf, topicOf } from '@/kc';

/**
 * The per-skill diagnostic layer, and nothing else. Per knowledge component a ring
 * of the last few observed signals (clean 1, shaky 0.5, wrong 0), whose plain mean
 * is the shown mastery. It steers the drill and review recommendations.
 *
 * The rating/rank system that used to live beside it (judged performance samples
 * averaged into an Elo-style number, rank bands, announcements, day deltas) was
 * removed by owner decision: the model's performance judgments were not reliable
 * enough to build an evaluation on, and drills are the part that earns its keep.
 * Persisted v2 stores carry the old samples; v3 migration keeps the skill rings and
 * the solved counter and drops the rest.
 *
 * Console access:  __nlSkills.all() · __nlSkills.rankings() · __nlSkills.reset()
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
  // Delivered hint rungs of the resolving error run, carried for the ledger.
  rungs?: number;
}

// Durable per-KC state (<=125 records): the last few signals and when.
export interface KCState {
  sig: number[]; // ring of recent signals, oldest first (clean 1, shaky 0.5, wrong 0)
  n: number; // lifetime observation count
  f: number; // lifetime misses (+0.5 per shaky), the "missed N×" chip
  lastSeen: number; // ms epoch, 0 = never
}

export interface SkillStore {
  version: 3;
  kcs: Record<string, KCState>;
  // Session-line day stats: CORRECTs delivered today.
  solvedDay: number;
  solvedCount: number;
}

const KEY = 'nl.skills.v3';
const OLD_KEY = 'nl.skills.v2';
const DAY = 86_400_000;
const RING = 12; // per-KC memory: the last dozen observations decide the shown mastery
const FRESH_DAYS = 30; // freshness fades linearly to 0 over this many idle days

function fresh(): SkillStore {
  return {
    version: 3,
    kcs: {},
    solvedDay: 0,
    solvedCount: 0,
  };
}

// v2 carried the rating machinery (performance samples, rating log, announced rank);
// only the skill rings and the solved counter survive into v3.
function migrateV2(p: {
  kcs?: Record<string, KCState>;
  solvedDay?: number;
  solvedCount?: number;
}): SkillStore {
  const kcs: Record<string, KCState> = {};
  for (const [id, kc] of Object.entries(p.kcs ?? {})) {
    if (!kc || !KC_SET.has(id) || !Array.isArray(kc.sig)) continue;
    kcs[id] = {
      sig: kc.sig.slice(-RING),
      n: kc.n ?? kc.sig.length,
      f: kc.f ?? 0,
      lastSeen: kc.lastSeen ?? 0,
    };
  }
  return {
    version: 3,
    kcs,
    solvedDay: p.solvedDay ?? 0,
    solvedCount: p.solvedCount ?? 0,
  };
}

function load(): SkillStore {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const p = JSON.parse(saved) as Partial<SkillStore>;
      if (p && p.version === 3 && p.kcs) {
        return { ...fresh(), ...p } as SkillStore;
      }
    }
    const old = localStorage.getItem(OLD_KEY);
    if (old) {
      const migrated = migrateV2(JSON.parse(old));
      localStorage.setItem(KEY, JSON.stringify(migrated));
      localStorage.removeItem(OLD_KEY);
      return migrated;
    }
  } catch {
    /* fall through to a fresh store */
  }
  return fresh();
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
    kc = { sig: [], n: 0, f: 0, lastSeen: 0 };
    skillStore.kcs[id] = kc;
  }
  return kc;
}

function signalRank(sig: KCObservation['signal']): number {
  return sig === 'wrong' ? 3 : sig === 'shaky' ? 2 : sig === 'clean' ? 1 : 0;
}

/**
 * Fold one graded page's skill tags into the diagnostic layer: validate ids, dedupe
 * keeping the worst signal, then push each signal onto its skill's ring. That is the
 * whole update.
 */
export function applySkillPacket(
  packet: SkillPacket,
  _steps: number,
  now: number,
  meta?: { source: 'resolve' | 'abandon'; label?: string },
): void {
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

  for (const o of signed) {
    const kc = materialize(o.id);
    const sc = o.signal === 'clean' ? 1 : o.signal === 'shaky' ? 0.5 : 0;
    kc.sig.push(sc);
    if (kc.sig.length > RING) kc.sig.shift();
    kc.n += 1;
    if (o.signal === 'wrong') kc.f += 1;
    else if (o.signal === 'shaky') kc.f += 0.5;
    kc.lastSeen = now;
  }
  persist();

  logEvent('packet', {
    source: meta?.source ?? 'resolve',
    label: meta?.label ?? '',
    skills: signed.map((o) => `${o.id}:${o.role === 'core' ? 'c' : 's'}:${(o.signal as string)[0]}`),
  });
}

// ---- session-line day stats ----

// Counted at the moment a CORRECT is actually delivered (deliver()'s dedup key makes
// that once per problem), never derived from usage buckets.
export function noteSolved(now = Date.now()): void {
  const day = Math.floor(now / DAY);
  if (skillStore.solvedDay !== day) {
    skillStore.solvedDay = day;
    skillStore.solvedCount = 0;
  }
  skillStore.solvedCount += 1;
  persist();
}

export function solvedToday(now = Date.now()): number {
  const day = Math.floor(now / DAY);
  return skillStore.solvedDay === day ? skillStore.solvedCount : 0;
}

// ---- the diagnostic layer: per-skill mastery for weak spots and drills ----

function masteryOf(kc: KCState): number {
  if (!kc.sig.length) return 0;
  return kc.sig.reduce((a, b) => a + b, 0) / kc.sig.length;
}

// Freshness fades linearly to 0 over FRESH_DAYS idle days; enough to rank rusty
// skills without a forgetting-curve model.
function freshness(kc: KCState, now: number): number {
  if (!kc.lastSeen) return 1;
  return Math.max(0, 1 - (now - kc.lastSeen) / DAY / FRESH_DAYS);
}

export interface KCView {
  id: string;
  label: string;
  domain: string;
  topic: string;
  masteryPct: number;
  n: number;
  R: number; // freshness 0..1
  daysSince: number;
  fresh: boolean;
  f: number;
  provisional: boolean;
}

export function kcView(now = Date.now()): KCView[] {
  const out: KCView[] = [];
  for (const id of Object.keys(skillStore.kcs)) {
    const kc = skillStore.kcs[id];
    if (kc.n <= 0 || !kc.sig.length) continue;
    const R = freshness(kc, now);
    out.push({
      id,
      label: labelOf(id),
      domain: domainOf(id),
      topic: topicOf(id),
      masteryPct: Math.round(100 * masteryOf(kc)),
      n: kc.n,
      R,
      daysSince: kc.lastSeen ? Math.floor((now - kc.lastSeen) / DAY) : 0,
      fresh: R >= 0.5,
      f: Math.round(kc.f),
      provisional: kc.n < 3,
    });
  }
  return out;
}

export interface RankRow extends KCView {
  score: number;
}

function ranked(metric: (v: KCView) => number, minN: number, now: number): RankRow[] {
  const rows: RankRow[] = [];
  for (const v of kcView(now)) {
    if (v.n < minN) continue;
    rows.push({ ...v, score: metric(v) });
  }
  return rows.sort((a, b) => b.score - a.score).slice(0, 8);
}

export function rankings(now = Date.now()) {
  return {
    // Genuinely weak skills (low mastery), lightly tie-broken by staleness.
    drill: ranked((v) => (1 - v.masteryPct / 100) * (0.7 + 0.3 * (1 - v.R)), 2, now),
    // Strong but going stale, the refresh list.
    fading: ranked((v) => (v.masteryPct / 100) * (1 - v.R), 2, now),
    // Confident strengths.
    strongest: ranked((v) => (v.masteryPct / 100) * Math.min(1, v.n / 5), 3, now),
  };
}

export interface PracticeRec {
  drill: RankRow | null; // weakest touched skill worth practising now
  review: RankRow | null; // strongest skill going stale, worth a refresh
}

export function recommendPractice(now = Date.now()): PracticeRec {
  const r = rankings(now);
  return { drill: r.drill[0] ?? null, review: r.fading[0] ?? null };
}

export function skillSummary(now = Date.now()) {
  const views = kcView(now);
  const byDomain = new Map<string, { sum: number; touched: number }>();
  for (const v of views) {
    const d = byDomain.get(v.domain) ?? { sum: 0, touched: 0 };
    d.sum += v.masteryPct;
    d.touched += 1;
    byDomain.set(v.domain, d);
  }
  const rollup = DOMAINS.filter((d) => byDomain.has(d.key)).map((d) => {
    const agg = byDomain.get(d.key)!;
    return {
      domain: d.key,
      label: d.label,
      masteryPct: Math.round(agg.sum / agg.touched),
      touched: agg.touched,
      total: KC_DEFS.filter((k) => k.domain === d.key).length,
    };
  });
  const ordered = [...rollup].sort((a, b) => a.masteryPct - b.masteryPct);
  return {
    coveredKCs: views.length,
    totalKCs: KC_DEFS.length,
    domainsTouched: rollup.length,
    totalDomains: DOMAINS.length,
    weakest: ordered[0] ?? null,
    strongest: ordered.length ? ordered[ordered.length - 1] : null,
    rusty: views.filter((v) => v.masteryPct >= 60 && v.daysSince > 14).length,
  };
}

export function resetSkills(): void {
  for (const k of Object.keys(skillStore.kcs)) delete skillStore.kcs[k];
  skillStore.solvedDay = 0;
  skillStore.solvedCount = 0;
  persist();
}

if (typeof window !== 'undefined') {
  (window as unknown as { __nlSkills: unknown }).__nlSkills = {
    all: () => skillStore.kcs,
    rankings: () => rankings(),
    recommend: () => recommendPractice(),
    summary: () => skillSummary(),
    reset: resetSkills,
  };
}
