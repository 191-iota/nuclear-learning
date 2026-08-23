import { reactive, watch } from 'vue';
import defaults from '@config/settings.json';

/**
 * Runtime-editable engine settings. Seeded from config/settings.json, overlaid
 * with anything the user changed in the Presets view (persisted to localStorage).
 * useCanvas / useFeedback read from this reactive object instead of the static
 * JSON, so tweaking model / effort / image quality / prices takes effect live.
 */
export type Settings = typeof defaults;

// Bumped when the shipped defaults change in a way that must override a stale saved copy
// (new fields, model swaps). A bump drops the old localStorage and re-seeds from
// config/settings.json on next load. (v23: the scan loop is gone — minNewStrokes,
// idleFlushMs, and correctionGraceMs left with it; only autoClearSec remains of the
// scan section, and checks now run on button press. Solve/hint/confirm move to
// gpt-5.6-terra, which bills exactly what gpt-5.4 does today; the check stays on
// gpt-5.4-mini, the cheapest capable tier.)
// NOT bumped for the `hold` section, api.noteModel/noteEffort, or api.backgroundModel
// (2026-08-06): load() copies a saved section OVER a full clone of the defaults, so a
// field or a whole section that only exists in the new defaults survives the merge
// untouched. A purely additive change needs no bump, and bumping for one would throw
// away every value the user had tuned to buy nothing.
const KEY = 'nl.settings.v26';

// The ink the shipped default used to be. A saved copy holding it follows the new one
// below, and the pictures already on disk were drawn with it (see inkOnDisk).
//
// This one migration happens ONCE and says so, which the others above do not. They can
// afford to re-fire, because nobody sets a pen width to exactly the retired default on
// purpose; a colour is different. Picking the old near-black by hand is a real thing to
// want, and without the mark below the next boot would take it away again.
const OLD_INK = '#1a1a1a';
const INK_MIGRATED = 'nl.ink.migrated.v1';

let inkBefore = '';
let inkMigrated = false;

function load(): Settings {
  const base = structuredClone(defaults) as Settings;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<Settings>;
      const ink = (parsed.canvas as Settings['canvas'] | undefined)?.strokeColor;
      if (typeof ink === 'string' && ink) inkBefore = ink;
      for (const k of Object.keys(parsed) as (keyof Settings)[]) {
        const section = base[k];
        const savedSection = parsed[k];
        if (section && typeof section === 'object' && savedSection) {
          Object.assign(section as object, savedSection as object);
        } else if (savedSection !== undefined) {
          (base[k] as unknown) = savedSection;
        }
      }
    }
  } catch {
    /* fall back to defaults */
  }
  // The shipped pen width dropped from 2.4 to 1.7 to 1.2 (each step: still too
  // thick in practice), and the scratch column was retired (the whole math page is
  // graded now, default share 0.28 → 0). A saved copy of an OLD default follows the
  // new one; a value the user picked by hand stays theirs.
  if (base.tablet.baseWidth === 2.4 || base.tablet.baseWidth === 1.7) {
    base.tablet.baseWidth = defaults.tablet.baseWidth;
  }
  if (base.tablet.scratchShare === 0.28) base.tablet.scratchShare = 0;
  // Same rule for the two that were retuned afterwards. Smoothing went 0.35 → 0.5
  // (0.35 still let a slow hand read as a shaky one), and the exported picture went
  // 1400 px at quality 0.95 → 1600 at 0.97, which is as much detail as one image can
  // carry before the vision model rescales it on the way in and thins the ink doing so.
  if (base.tablet.smoothing === 0.35) base.tablet.smoothing = defaults.tablet.smoothing;
  if (base.export.maxEdgePx === 1400) base.export.maxEdgePx = defaults.export.maxEdgePx;
  if (base.export.jpegQuality === 0.95) base.export.jpegQuality = defaults.export.jpegQuality;
  // Same rule for the ink: a saved copy of the old near-black follows the new ink,
  // a colour picked by hand stays. Why this colour is inkExport's drawStrokes; what
  // it means for notes written in the old one is stores/inkColor.ts.
  let inkDone = false;
  try {
    inkDone = Boolean(localStorage.getItem(INK_MIGRATED));
  } catch {
    /* no storage: treat it as never migrated, which is the safe half */
  }
  if (base.canvas.strokeColor === OLD_INK && !inkDone) {
    base.canvas.strokeColor = defaults.canvas.strokeColor;
    inkMigrated = true;
  }
  return base;
}

export const settings = reactive(load());

// A migration nothing has changed since would otherwise live only in memory: the saved
// copy still holds the old ink, and the watcher below only writes on a change. Writing
// it now is what makes the migration a single event with a record, rather than
// something that happens again on every boot.
if (inkMigrated) {
  try {
    localStorage.setItem(KEY, JSON.stringify(sanitized()));
    localStorage.setItem(INK_MIGRATED, '1');
  } catch {
    /* storage unavailable; the ink is still right for this session */
  }
}

/**
 * The ink colour in force before this load, which is the colour every picture of a
 * note on disk was drawn with. Only stores/inkColor.ts has any use for it, and only
 * once: it is the starting point of the one-off recolour, after which that store
 * keeps its own record of what has been re-rendered.
 */
export const inkOnDisk = inkBefore || OLD_INK;

// v-model.number leaves '' (or a half-typed string) on the reactive object while a field
// can't parse, and `n < ''` coerces to `n < 0` — an emptied "Re-check after (strokes)"
// silently disabled the scan gate and fired a full image scan per stroke. Persist a
// sanitized copy immediately (so a reload never resurrects ''), and repair the live
// object shortly after typing settles (not per keystroke, which would fight the input).
function sanitized(): Settings {
  const copy = JSON.parse(JSON.stringify(settings)) as Settings;
  for (const k of Object.keys(defaults) as (keyof Settings)[]) {
    const d = defaults[k] as unknown as Record<string, unknown>;
    const c = copy[k] as unknown as Record<string, unknown>;
    if (!d || typeof d !== 'object' || !c) continue;
    for (const f of Object.keys(d)) {
      if (typeof d[f] === 'number' && !Number.isFinite(c[f] as number)) c[f] = d[f];
    }
  }
  return copy;
}

let repairTimer: number | undefined;
function scheduleRepair(): void {
  if (typeof window === 'undefined') return;
  if (repairTimer) window.clearTimeout(repairTimer);
  repairTimer = window.setTimeout(() => {
    repairTimer = undefined;
    const clean = sanitized();
    for (const k of Object.keys(defaults) as (keyof Settings)[]) {
      const c = clean[k] as unknown as Record<string, unknown>;
      const s = settings[k] as unknown as Record<string, unknown>;
      if (!c || typeof c !== 'object' || !s) continue;
      for (const f of Object.keys(c)) {
        if (typeof c[f] === 'number' && s[f] !== c[f] && !Number.isFinite(s[f] as number)) {
          s[f] = c[f];
        }
      }
    }
  }, 1500);
}

watch(
  settings,
  () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(sanitized()));
    } catch {
      /* storage full / unavailable, non-fatal */
    }
    scheduleRepair();
  },
  { deep: true },
);

export function resetSettings(): void {
  const fresh = structuredClone(defaults) as Settings;
  Object.assign(settings, fresh);
}
