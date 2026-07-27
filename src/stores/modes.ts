import { ref, watch } from 'vue';
import type { Mode } from '@/types';
import defaultModes from '@config/modes.json';

/**
 * User-editable feedback presets. Seeded from config/modes.json; edits and custom
 * presets are persisted to localStorage. The Presets view mutates this directly;
 * MainView reads it reactively so prompt / debounce / effort changes apply live.
 */
// Bumped when the shipped modes change in a way a stale saved copy must not shadow
// (v18: the scan loop is gone — the page is judged ON DEMAND via four buttons. The
// prompt now names the four requests (capture / check / hint / finish), CORRECT is
// reserved for the finish request, ink marks lose all protocol meaning, the
// simplification remark moves to the finish check, and a STUCK HINTS section drives
// the hint button's next-step ladder. debounceMs left the Mode shape with the loop.)
// A bump drops the old localStorage and re-seeds from config/modes.json on next load,
// so new behaviour actually reaches an existing browser. (v20: the capture's
// read-back ("statement") is the learner-editable statement of record — accepted by
// silence, corrected by hand, and authoritative over the statement ink on every
// grading request; grading requests report the sub-questions they confirmed
// ("cleared", locked against re-flagging), and ambiguous two-way symbols are rewrite
// requests instead of errors. The v19 auto-reread guard is gone: the learner's edit
// is the misread recovery.)
const KEY = 'nl.modes.v20';
// The prompt version, exported so the observation ledger can stamp each event with the
// rater that produced it: a 1900 graded under v14 and a 1900 under v16 are different
// scales, and that drift is only diagnosable if the events say who judged them.
export const MODES_KEY = KEY;

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
    // First load under this version. A bump must replace the SHIPPED presets, but the
    // user's own presets are not ours to delete: carry `custom-*` entries over from the
    // newest old key, then drop the stale keys so they stop accumulating forever.
    const old: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && /^nl\.modes\.v\d+$/.test(k) && k !== KEY) old.push(k);
    }
    if (old.length) {
      old.sort((a, b) => Number(b.slice(10)) - Number(a.slice(10)));
      const carried: Mode[] = [];
      try {
        const prev = JSON.parse(localStorage.getItem(old[0]) ?? '[]') as Mode[];
        if (Array.isArray(prev)) {
          for (const m of prev) {
            if (m && typeof m.id === 'string' && m.id.startsWith('custom-')) carried.push(m);
          }
        }
      } catch {
        /* unreadable old save: nothing to carry */
      }
      for (const k of old) localStorage.removeItem(k);
      if (carried.length) return [...seed(), ...carried];
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
