import { settings } from '@/stores/settings';

/**
 * The cadence of a held undo: how long before repeating starts, and how fast it goes
 * once it has. Three places drive the same behaviour (the pen's barrel button in the
 * ink engine, Z on the math pad, Z in the notes editor), so the timing lives here and
 * they all ask the same question rather than each carrying its own constants.
 *
 * Removal ACCELERATES the longer the button is down. A flat rate has to be one
 * compromise: quick enough to clear a paragraph without waiting, slow enough to stop
 * on the one stroke you meant. It cannot be both, and picking the fast end means a
 * short press overshoots. Ramping solves it by making the two cases different: the
 * first strokes come off slowly enough to release on the right one, and a button still
 * held after that is plainly not aiming at a single stroke, so the rate climbs to
 * where clearing a whole board is a couple of seconds.
 *
 * The ramp is linear in the GAP between removals, which makes the rate itself climb
 * ever faster, the shape a hold actually wants: barely moving at first, running away
 * by the end. It is expressed in strokes per second because that is the unit the
 * behaviour is judged in; the gap is what the clock needs, and 1000/rate converts.
 */

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

/** How long the button must be down before removal repeats at all. */
export function holdDelayMs(): number {
  return num(settings.hold?.delayMs, 450, 0, 5000);
}

/**
 * The gap to leave before the next removal, given how long the hold has lasted. Rates
 * are capped at 60/s because the callers poll on a 10ms tick, and asking for gaps
 * shorter than a couple of ticks would quantise the ramp instead of following it.
 */
export function holdGapMs(heldMs: number): number {
  const start = num(settings.hold?.startRate, 9, 0.5, 60);
  const top = num(settings.hold?.topRate, 36, 0.5, 60);
  const ramp = num(settings.hold?.rampSec, 2.2, 0, 30) * 1000;
  const startGap = 1000 / start;
  const topGap = 1000 / top;
  // Past the ramp the rate simply stays at the top; before it, walk from one gap to
  // the other. A zero ramp means "top speed immediately", which stays well defined.
  const t = ramp <= 0 ? 1 : Math.min(1, Math.max(0, (heldMs - holdDelayMs()) / ramp));
  return startGap + (topGap - startGap) * t;
}

/**
 * Whether the next removal is due. `last` is the clock reading of the previous one,
 * and 0 means none has happened yet, so the first removal fires as soon as the delay
 * is served. Callers poll this from whatever they already have (an OS key repeat, a
 * timer) instead of the timing living in each of them.
 */
export function holdDue(started: number, last: number, now: number): boolean {
  const held = now - started;
  if (held < holdDelayMs()) return false;
  return now - last >= holdGapMs(held);
}
