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
export type Role = 'solve' | 'verify' | 'confirm';

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
  return r.model ?? 'claude-opus-4-8';
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

export function usageSummary() {
  let input = 0;
  let output = 0;
  let solves = 0;
  let verifies = 0;
  let cost = 0;
  for (const r of usage.records) {
    const info = modelInfo(recModel(r));
    input += r.input;
    output += r.output;
    if (recRole(r) === 'solve') solves += 1;
    else verifies += 1;
    cost += (r.input * info.in + r.output * info.out) / 1e6;
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
  };
}

if (typeof window !== 'undefined') {
  (window as unknown as { __nlUsage: unknown }).__nlUsage = {
    records: () => usage.records.slice(),
    summary: usageSummary,
    perPage,
    clear: clearUsage,
  };
}
