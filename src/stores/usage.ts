import { reactive } from 'vue';
import { modelInfo } from '@/models';

/**
 * Reactive token-usage log. Every scan records its API `usage` here; the Usage
 * dashboard reads it live. Records are grouped by "page" (one Clear-to-Clear
 * session) and persisted to localStorage so the dashboard survives reloads.
 *
 * Each record carries the model it ran on, so cost is priced per record (the
 * tiered flow runs solves/confirms on Opus and routine verifies on a cheap model).
 *
 * Console access:  __nlUsage.summary() · __nlUsage.records() · __nlUsage.clear()
 */
export type Role = 'ready' | 'solve' | 'verify' | 'confirm' | 'lesson';

// Human labels for the per-purpose breakdown.
export const ROLE_LABEL: Record<Role, string> = {
  ready: 'Ready check',
  solve: 'Solve',
  verify: 'Verify',
  confirm: 'Confirm',
  lesson: 'Lesson cards',
};

export interface UsageRecord {
  page: number;
  ts: number;
  mode: string;
  model: string;
  role: Role;
  input: number;
  output: number; // includes thinking tokens
  cacheRead: number;
  cacheCreate: number;
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

// Old records (pre-tiering) lack model/role; fall back gracefully so the chart
// still prices and groups them.
function recModel(r: UsageRecord): string {
  return r.model ?? 'o3';
}
function recRole(r: UsageRecord): Role {
  return r.role ?? ((r as unknown as { cached?: boolean }).cached ? 'verify' : 'solve');
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
  inputCostUSD: number;
  outputCostUSD: number;
  costUSD: number;
}

export function perPage(): PageStat[] {
  const byPage = new Map<number, PageStat>();
  for (const r of usage.records) {
    let s = byPage.get(r.page);
    if (!s) {
      s = {
        page: r.page,
        scans: 0,
        solves: 0,
        verifies: 0,
        input: 0,
        output: 0,
        inputCostUSD: 0,
        outputCostUSD: 0,
        costUSD: 0,
      };
      byPage.set(r.page, s);
    }
    const info = modelInfo(recModel(r));
    s.scans += 1;
    if (recRole(r) === 'solve') s.solves += 1;
    else s.verifies += 1;
    s.input += r.input;
    s.output += r.output;
    s.inputCostUSD += (r.input * info.in) / 1e6;
    s.outputCostUSD += (r.output * info.out) / 1e6;
  }
  const stats = [...byPage.values()].sort((a, b) => a.page - b.page);
  for (const s of stats) s.costUSD = s.inputCostUSD + s.outputCostUSD;
  return stats;
}

// One column per problem, but bucketed into at most `maxBars` so the chart stays the
// same width however many problems you do. While there are fewer problems than bars each
// column is exactly one problem (fromPage === toPage); past that, consecutive problems
// are folded into near-equal groups and their costs summed, so the per-problem shape (and
// the input/output split) survives the grouping instead of growing one bar forever.
export interface ProblemBar {
  fromPage: number;
  toPage: number;
  problems: number; // problems folded into this column (1 when not grouped)
  scans: number;
  input: number;
  output: number;
  inputCostUSD: number;
  outputCostUSD: number;
  costUSD: number;
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
      inputCostUSD: 0,
      outputCostUSD: 0,
      costUSD: 0,
    };
    for (const s of slice) {
      col.scans += s.scans;
      col.input += s.input;
      col.output += s.output;
      col.inputCostUSD += s.inputCostUSD;
      col.outputCostUSD += s.outputCostUSD;
    }
    col.costUSD = col.inputCostUSD + col.outputCostUSD;
    out.push(col);
  }
  return out;
}

const DAY = 86_400_000;

// Cost over time, one bucket per calendar day, capped to the most recent `maxDays`
// active days. Unlike per-problem this stays bounded however many problems you do.
export interface DayStat {
  day: number; // floor(ts / DAY)
  input: number;
  output: number;
  inputCostUSD: number;
  outputCostUSD: number;
  costUSD: number;
  scans: number;
}

export function perDay(maxDays = 30): DayStat[] {
  const byDay = new Map<number, DayStat>();
  for (const r of usage.records) {
    const day = Math.floor((r.ts ?? 0) / DAY);
    let s = byDay.get(day);
    if (!s) {
      s = { day, input: 0, output: 0, inputCostUSD: 0, outputCostUSD: 0, costUSD: 0, scans: 0 };
      byDay.set(day, s);
    }
    const info = modelInfo(recModel(r));
    s.scans += 1;
    s.input += r.input;
    s.output += r.output;
    s.inputCostUSD += (r.input * info.in) / 1e6;
    s.outputCostUSD += (r.output * info.out) / 1e6;
  }
  const out = [...byDay.values()].sort((a, b) => a.day - b.day);
  for (const s of out) s.costUSD = s.inputCostUSD + s.outputCostUSD;
  return out.slice(-maxDays);
}

// Cost split by purpose (solve / verify / confirm / classify / lesson card), so the
// dashboard can show where the money actually goes and surface the lesson-card spend.
export interface RoleStat {
  role: Role;
  label: string;
  count: number;
  input: number;
  output: number;
  costUSD: number;
}

export function byRole(): RoleStat[] {
  const m = new Map<Role, RoleStat>();
  for (const r of usage.records) {
    const role = recRole(r);
    let s = m.get(role);
    if (!s) {
      s = { role, label: ROLE_LABEL[role] ?? role, count: 0, input: 0, output: 0, costUSD: 0 };
      m.set(role, s);
    }
    const info = modelInfo(recModel(r));
    s.count += 1;
    s.input += r.input;
    s.output += r.output;
    s.costUSD += (r.input * info.in + r.output * info.out) / 1e6;
  }
  return [...m.values()].sort((a, b) => b.costUSD - a.costUSD);
}

export interface ModelStat {
  model: string;
  label: string;
  count: number;
  costUSD: number;
}

export function byModel(): ModelStat[] {
  const m = new Map<string, ModelStat>();
  for (const r of usage.records) {
    const model = recModel(r);
    const info = modelInfo(model);
    let s = m.get(model);
    if (!s) {
      s = { model, label: info.label, count: 0, costUSD: 0 };
      m.set(model, s);
    }
    s.count += 1;
    s.costUSD += (r.input * info.in + r.output * info.out) / 1e6;
  }
  return [...m.values()].sort((a, b) => b.costUSD - a.costUSD);
}

export function usageSummary() {
  let input = 0;
  let output = 0;
  let solves = 0;
  let verifies = 0;
  let cost = 0;
  let lessonCount = 0;
  let lessonCost = 0;
  for (const r of usage.records) {
    const info = modelInfo(recModel(r));
    const role = recRole(r);
    input += r.input;
    output += r.output;
    if (role === 'solve') solves += 1;
    else verifies += 1;
    const c = (r.input * info.in + r.output * info.out) / 1e6;
    cost += c;
    if (role === 'lesson') {
      lessonCount += 1;
      lessonCost += c;
    }
  }
  const scans = usage.records.length;
  const pages = new Set(usage.records.map((r) => r.page)).size || 1;
  return {
    scans,
    pages,
    totals: { input, output, solves, verifies },
    tokensTotal: input + output,
    tokensPerScan: scans ? Math.round((input + output) / scans) : 0,
    estCostUSD: +cost.toFixed(4),
    costPerPageUSD: +(cost / pages).toFixed(4),
    lessons: { count: lessonCount, costUSD: +lessonCost.toFixed(4) },
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
