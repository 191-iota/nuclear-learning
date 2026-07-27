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
const KEY = 'nl.settings.v25';

function load(): Settings {
  const base = structuredClone(defaults) as Settings;
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Partial<Settings>;
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
  return base;
}

export const settings = reactive(load());

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
