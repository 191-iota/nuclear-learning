import { settings } from '@/stores/settings';
import { MODES_KEY } from '@/stores/modes';

/**
 * Append-only observation ledger. The other stores keep only CURRENT state (theta and
 * RD, box and due date); the history that produced it is discarded, which makes the
 * rating unfalsifiable and mortal: one cache clear or origin change deletes the whole
 * record, and it has already happened once (the port migration). This ledger is the
 * durable record: one compact event per applied skill packet, per lesson review, and
 * per lesson capture, each stamped with the rater that produced it (prompt version +
 * model names), because a rating graded under one prompt version and a rating graded
 * under another are different scales and the drift is only diagnosable from raw events.
 *
 * It renders nothing and gates nothing. Consumption is offline: __nlObslog() for a
 * peek, __nlExport() to download every nl.* store as one JSON file (backup + the raw
 * material any future scheduler fit needs; no scheduler is fittable without a review
 * log). "Durable" honestly means exportable and replayable: the ledger lives in the
 * same localStorage as the state it protects, so export is the actual backup.
 */

export type ObsEventType = 'packet' | 'perf' | 'review' | 'capture';

export interface ObsEvent {
  t: number; // ms epoch
  type: ObsEventType;
  rater: string; // "<modes key>|<solve>|<verify>|<confirm>"
  [key: string]: unknown;
}

const KEY = 'nl.obslog.v1';
// Ring sizing: at the measured peak volume (~30 problems/day) 10k events hold well
// over a year. Eviction is never silent: a console warning fires at the high-water
// mark and again on the first actual eviction, telling you to export first.
const MAX_EVENTS = 10_000;
const WARN_AT = 9_000;

function load(): ObsEvent[] {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const p = JSON.parse(saved) as { events?: ObsEvent[] };
      if (Array.isArray(p.events)) return p.events;
    }
  } catch {
    /* fall through to a fresh ledger */
  }
  return [];
}

const events: ObsEvent[] = load();
let warnedHighWater = false;
let warnedEvict = false;
let warnedQuota = false;

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ events }));
  } catch {
    if (!warnedQuota) {
      warnedQuota = true;
      console.warn('[nuclear-math] obslog persist failed (storage full?); run __nlExport() and clear.');
    }
  }
}

function rater(): string {
  return `${MODES_KEY}|${settings.api.solveModel}|${settings.api.verifyModel}|${settings.api.confirmModel}`;
}

/** Append one event. Called per applied packet / review / capture, never per stroke. */
export function logEvent(type: ObsEventType, payload: Record<string, unknown>): void {
  events.push({ t: Date.now(), type, rater: rater(), ...payload });
  if (events.length >= WARN_AT && !warnedHighWater) {
    warnedHighWater = true;
    console.warn(`[nuclear-math] obslog at ${events.length}/${MAX_EVENTS} events; __nlExport() before the ring evicts.`);
  }
  if (events.length > MAX_EVENTS) {
    events.shift();
    if (!warnedEvict) {
      warnedEvict = true;
      console.warn('[nuclear-math] obslog full: oldest events are now being evicted. Export if you have not.');
    }
  }
  persist();
}

// Serialize every nl.* localStorage key into one downloadable JSON file: the backup
// for the whole instrument (skills, lessons, usage, settings, modes, this ledger).
function exportAll(): void {
  const stores: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i += 1) {
    const k = localStorage.key(i);
    if (!k || !k.startsWith('nl.')) continue;
    const raw = localStorage.getItem(k);
    try {
      stores[k] = raw === null ? null : JSON.parse(raw);
    } catch {
      stores[k] = raw;
    }
  }
  const blob = new Blob(
    [JSON.stringify({ exportedAt: new Date().toISOString(), origin: location.origin, stores }, null, 1)],
    { type: 'application/json' },
  );
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `nuclear-math-export-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
}

if (typeof window !== 'undefined') {
  (window as unknown as { __nlExport: unknown }).__nlExport = exportAll;
  (window as unknown as { __nlObslog: unknown }).__nlObslog = () => ({
    events: events.length,
    tail: events.slice(-10),
  });
}
