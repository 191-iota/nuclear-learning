import { reactive } from 'vue';
import { MODELS } from '@/models';

/**
 * Reactive token-usage log. Every request records its `usage` here; the Usage
 * dashboard reads it live. Records are grouped by "page" (one Clear-to-Clear
 * session) and persisted to localStorage so the dashboard survives reloads.
 *
 * It counted money once, because every token was billed. Nothing here is billed now:
 * the model runs on this machine, and the only thing a page costs is the time you spend
 * waiting for it. So the tab counts tokens, which is what that wait is made of and the
 * one honest measure left of how much the model was asked to read and write. Each
 * record still carries the model it ran on, because a page put through E4B and the same
 * page put through 12B are not the same work.
 *
 * Console access:  __nlUsage.summary() · __nlUsage.records() · __nlUsage.clear()
 */
export type Role = 'solve' | 'verify' | 'confirm' | 'hint' | 'ask' | 'lesson' | 'drill' | 'index' | 'note';

// Human labels for the per-purpose breakdown.
export const ROLE_LABEL: Record<Role, string> = {
  solve: 'Solve',
  verify: 'Check',
  confirm: 'Finish',
  hint: 'Hints',
  ask: 'Questions',
  lesson: 'Lesson cards',
  drill: 'Drill problems',
  index: 'Archive index',
  note: 'Note transcripts',
};

export interface UsageRecord {
  page: number;
  ts: number;
  mode: string;
  model: string;
  role: Role;
  input: number;
  output: number; // includes thinking tokens
}

const KEY = 'nl.usage.v1';
const MAX_RECORDS = 2000;

interface Persisted {
  page: number;
  records: UsageRecord[];
}

function load(): Persisted {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Persisted;
      if (Array.isArray(parsed.records)) return parsed;
    }
  } catch {
    /* ignore */
  }
  return { page: 1, records: [] };
}

export const usage = reactive(load());

// Old records (pre-tiering) lack model/role; fall back gracefully so the chart still
// groups them. Records written before the app moved to local models keep the hosted id
// they ran on, and modelLabel() below shows it as it was rather than renaming it.
function recModel(r: UsageRecord): string {
  return r.model ?? 'unknown';
}
function recRole(r: UsageRecord): Role {
  return r.role ?? ((r as unknown as { cached?: boolean }).cached ? 'verify' : 'solve');
}
function modelLabel(id: string): string {
  return MODELS.find((m) => m.id === id)?.label ?? id;
}
function tokensOf(r: UsageRecord): number {
  return (r.input ?? 0) + (r.output ?? 0);
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(usage));
  } catch {
    /* non-fatal */
  }
}

export function newPage(): void {
  usage.page += 1;
  // Persist the bump itself: a reload straight after Clear used to resurrect the old
  // page number and merge the next problem's records into the previous problem's bar.
  persist();
}

export function recordUsage(entry: Omit<UsageRecord, 'page' | 'ts'>): void {
  usage.records.push({ page: usage.page, ts: Date.now(), ...entry });
  if (usage.records.length > MAX_RECORDS) {
    usage.records.splice(0, usage.records.length - MAX_RECORDS);
  }
  persist();
}

export function clearUsage(): void {
  usage.records.splice(0, usage.records.length);
  usage.page = 1;
  persist();
}

export interface PageStat {
  page: number;
  scans: number;
  solves: number;
  verifies: number;
  input: number;
  output: number;
  tokens: number;
}

export function perPage(): PageStat[] {
  const byPage = new Map<number, PageStat>();
  for (const r of usage.records) {
    let s = byPage.get(r.page);
    if (!s) {
      s = { page: r.page, scans: 0, solves: 0, verifies: 0, input: 0, output: 0, tokens: 0 };
      byPage.set(r.page, s);
    }
    // Lesson cards and drill problems are page-less side calls, not scans of the pad;
    // their tokens still land on the page's totals but never in the scan buckets.
    const role = recRole(r);
    if (role !== 'lesson' && role !== 'drill') {
      s.scans += 1;
      if (role === 'solve') s.solves += 1;
      else s.verifies += 1;
    }
    s.input += r.input;
    s.output += r.output;
  }
  const stats = [...byPage.values()].sort((a, b) => a.page - b.page);
  for (const s of stats) s.tokens = s.input + s.output;
  return stats;
}

// One column per problem, but bucketed into at most `maxBars` so the chart stays the
// same width however many problems you do. While there are fewer problems than bars each
// column is exactly one problem (fromPage === toPage); past that, consecutive problems
// are folded into near-equal groups and their tokens summed, so the per-problem shape (and
// the input/output split) survives the grouping instead of growing one bar forever.
export interface ProblemBar {
  fromPage: number;
  toPage: number;
  problems: number; // problems folded into this column (1 when not grouped)
  scans: number;
  input: number;
  output: number;
  tokens: number;
}

export function perProblemBars(maxBars = 48): ProblemBar[] {
  const pages = perPage();
  const n = pages.length;
  if (n === 0) return [];
  const bars = Math.min(maxBars, n);
  const out: ProblemBar[] = [];
  for (let b = 0; b < bars; b += 1) {
    const slice = pages.slice(Math.floor((b * n) / bars), Math.floor(((b + 1) * n) / bars));
    if (!slice.length) continue;
    const col: ProblemBar = {
      fromPage: slice[0].page,
      toPage: slice[slice.length - 1].page,
      problems: slice.length,
      scans: 0,
      input: 0,
      output: 0,
      tokens: 0,
    };
    for (const s of slice) {
      col.scans += s.scans;
      col.input += s.input;
      col.output += s.output;
    }
    col.tokens = col.input + col.output;
    out.push(col);
  }
  return out;
}

const DAY = 86_400_000;

// Tokens over time, one bucket per calendar day, capped to the most recent `maxDays`
// active days. Unlike per-problem this stays bounded however many problems you do.
export interface DayStat {
  day: number; // floor(ts / DAY)
  input: number;
  output: number;
  tokens: number;
  scans: number;
}

export function perDay(maxDays = 30): DayStat[] {
  const byDay = new Map<number, DayStat>();
  for (const r of usage.records) {
    const day = Math.floor((r.ts ?? 0) / DAY);
    let s = byDay.get(day);
    if (!s) {
      s = { day, input: 0, output: 0, tokens: 0, scans: 0 };
      byDay.set(day, s);
    }
    // Same scan semantics as perPage: lesson cards and drills read and write tokens but
    // are not scans.
    const role = recRole(r);
    if (role !== 'lesson' && role !== 'drill') s.scans += 1;
    s.input += r.input;
    s.output += r.output;
  }
  const out = [...byDay.values()].sort((a, b) => a.day - b.day);
  for (const s of out) s.tokens = s.input + s.output;
  return out.slice(-maxDays);
}

// Split by purpose (solve / verify / confirm / hint / lesson card), so the dashboard can
// show where the reading and the writing actually go, and surface what the deck costs.
export interface RoleStat {
  role: Role;
  label: string;
  count: number;
  input: number;
  output: number;
  tokens: number;
}

export function byRole(): RoleStat[] {
  const m = new Map<Role, RoleStat>();
  for (const r of usage.records) {
    const role = recRole(r);
    let s = m.get(role);
    if (!s) {
      s = { role, label: ROLE_LABEL[role] ?? role, count: 0, input: 0, output: 0, tokens: 0 };
      m.set(role, s);
    }
    s.count += 1;
    s.input += r.input;
    s.output += r.output;
    s.tokens += tokensOf(r);
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens);
}

export interface ModelStat {
  model: string;
  label: string;
  count: number;
  input: number;
  output: number;
  tokens: number;
}

export function byModel(): ModelStat[] {
  const m = new Map<string, ModelStat>();
  for (const r of usage.records) {
    const model = recModel(r);
    let s = m.get(model);
    if (!s) {
      s = { model, label: modelLabel(model), count: 0, input: 0, output: 0, tokens: 0 };
      m.set(model, s);
    }
    s.count += 1;
    s.input += r.input;
    s.output += r.output;
    s.tokens += tokensOf(r);
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens);
}

export function usageSummary() {
  let input = 0;
  let output = 0;
  let solves = 0;
  let verifies = 0;
  let lessonCount = 0;
  let lessonTokens = 0;
  for (const r of usage.records) {
    const role = recRole(r);
    input += r.input;
    output += r.output;
    if (role === 'solve') solves += 1;
    else if (role !== 'lesson' && role !== 'drill') verifies += 1;
    if (role === 'lesson') {
      lessonCount += 1;
      lessonTokens += tokensOf(r);
    }
  }
  const scans = usage.records.filter((r) => {
    const role = recRole(r);
    return role !== 'lesson' && role !== 'drill';
  }).length;
  const pages = new Set(usage.records.map((r) => r.page)).size || 1;
  return {
    scans,
    pages,
    totals: { input, output, solves, verifies },
    tokensTotal: input + output,
    tokensPerScan: scans ? Math.round((input + output) / scans) : 0,
    tokensPerPage: Math.round((input + output) / pages),
    lessons: { count: lessonCount, tokens: lessonTokens },
  };
}

if (typeof window !== 'undefined') {
  (window as unknown as { __nlUsage: unknown }).__nlUsage = {
    records: () => usage.records.slice(),
    summary: usageSummary,
    perPage,
    perProblemBars,
    perDay,
    byRole,
    byModel,
    clear: clearUsage,
  };
}
