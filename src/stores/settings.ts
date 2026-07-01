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
// (new fields, the corner-gate flow, model swaps). A bump drops the old localStorage and
// re-seeds from config/settings.json on next load.
const KEY = 'nl.settings.v11';

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

watch(
  settings,
  () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(settings));
    } catch {
      /* storage full / unavailable, non-fatal */
    }
  },
  { deep: true },
);

export function resetSettings(): void {
  const fresh = structuredClone(defaults) as Settings;
  Object.assign(settings, fresh);
}
