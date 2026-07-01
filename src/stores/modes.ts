import { ref, watch } from 'vue';
import type { Mode } from '@/types';
import defaultModes from '@config/modes.json';

/**
 * User-editable feedback presets. Seeded from config/modes.json; edits and custom
 * presets are persisted to localStorage. The Presets view mutates this directly;
 * MainView reads it reactively so prompt / debounce / effort changes apply live.
 */
// Bumped when the shipped modes change in a way a stale saved copy must not shadow (the
// corner-gate flag and prompt). A bump drops the old localStorage and re-seeds from
// config/modes.json on next load, so new behaviour actually reaches an existing browser.
const KEY = 'nl.modes.v2';

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

export function addMode(): Mode {
  const preset: Mode = {
    id: `custom-${Date.now()}`,
    label: 'New preset',
    systemPrompt:
      'You are checking handwritten work, re-scanned as the learner writes. Reply with EXACTLY ONE of: OK while correct so far but unfinished, CORRECT when finished and correct, or a single short sentence naming the first error. Add no other text.',
    feedbackStyle: 'both',
    debounceMs: 5000,
    errorChecking: true,
    cacheSolution: false,
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
