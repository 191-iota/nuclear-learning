import { ref, watch } from 'vue';
import type { Mode } from '@/types';
import defaultModes from '@config/modes.json';

/**
 * User-editable feedback presets. Seeded from config/modes.json; edits and custom
 * presets are persisted to localStorage. The Presets view mutates this directly;
 * MainView reads it reactively so prompt / debounce / effort changes apply live.
 */
// Bumped when the shipped modes change in a way a stale saved copy must not shadow (v8:
// Zwischenresultate — an unmarked correct-but-unsimplified line is OK, the finish nudge is
// reserved for marked results and never names the missing step). A bump drops the old
// localStorage and re-seeds from config/modes.json on next load, so new behaviour actually
// reaches an existing browser.
const KEY = 'nl.modes.v8';

function seed(): Mode[] {
  return structuredClone(defaultModes) as unknown as Mode[];
}

function load(): Mode[] {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as Mode[];
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  } catch {
    /* fall back to defaults */
  }
  return seed();
}

export const modes = ref<Mode[]>(load());

watch(
  modes,
  () => {
    try {
      localStorage.setItem(KEY, JSON.stringify(modes.value));
    } catch {
      /* non-fatal */
    }
  },
  { deep: true },
);

// A new preset clones the SHIPPED math grader, so a variant starts from the tuned
// baseline (conventions, hint rules, self-correction protocol) instead of a bare stub.
export function addMode(): Mode {
  const base = seed()[0];
  const preset: Mode = {
    ...base,
    id: `custom-${Date.now()}`,
    label: 'Math variant',
  };
  modes.value.push(preset);
  return preset;
}

export function removeMode(id: string): void {
  if (modes.value.length <= 1) return; // keep at least one preset
  modes.value = modes.value.filter((m) => m.id !== id);
}

export function resetModes(): void {
  modes.value = seed();
}
