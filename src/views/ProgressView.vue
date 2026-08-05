<script setup lang="ts">
import { computed, ref } from 'vue';
import { rankings, skillSummary, resetSkills } from '@/stores/skills';
import { generateDrill, type DrillProblem } from '@/drill';
import { practiceText } from '@/stores/archive';
import MathText from '@/components/MathText.vue';

// The tab answers one question now: what should I drill. The rating/rank layer that
// used to sit above this was removed by owner decision (the model's performance
// judgments were too unreliable to build an evaluation on); the skill map stays as
// the internal diagnostic that feeds the weak-spot list and the drill targeting,
// and every drill here is triggered by hand.

const summary = computed(() => skillSummary());

// Weak spots: the weakest tracked skills plus strong-but-rusty ones, deduped, capped.
// No percentages — the reason chip says something concrete instead.
interface WeakSpot {
  id: string;
  label: string;
  masteryPct: number;
  reason: string;
}
const weakSpots = computed<WeakSpot[]>(() => {
  const r = rankings();
  const rows: WeakSpot[] = [
    ...r.drill.map((x) => ({
      id: x.id,
      label: x.label,
      masteryPct: x.masteryPct,
      reason: x.f >= 1 ? `missed ${x.f}×` : 'shaky',
    })),
    ...r.fading.map((x) => ({
      id: x.id,
      label: x.label,
      masteryPct: x.masteryPct,
      reason: `rusty · ${x.daysSince}d`,
    })),
  ];
  const seen = new Set<string>();
  const out: WeakSpot[] = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= 8) break;
  }
  return out;
});

const drill = ref<DrillProblem | null>(null);
const drillBusy = ref(false);
const drillError = ref(false);
async function makeDrill(target?: { id: string; masteryPct: number }) {
  const t = target ?? weakSpots.value[0];
  if (!t || drillBusy.value) return;
  drillBusy.value = true;
  drillError.value = false;
  try {
    // Keep the previous problem on screen until a new one actually arrives.
    const p = await generateDrill(t.id, t.masteryPct);
    if (p) drill.value = p;
    else drillError.value = true;
  } finally {
    drillBusy.value = false;
  }
}

// Send the drill to the pad: the same pin mechanism the Archive's "Practice again"
// uses, so the problem sits beside the ink while you copy and solve it.
function toPad(): void {
  if (!drill.value) return;
  practiceText.value = `${drill.value.task} ${drill.value.problem}`.trim();
}

function reset() {
  if (confirm('Reset all tracked skill mastery? This cannot be undone.')) {
    resetSkills();
    drill.value = null;
  }
}
</script>

<template>
  <section class="scroll">
    <div class="page-head">
      <h2>Progress</h2>
      <span class="spacer" />
      <button v-if="summary.coveredKCs > 0" class="ghost danger" @click="reset">Reset</button>
    </div>

    <template v-if="summary.coveredKCs > 0">
      <div class="card">
        <div class="sum-row mono muted">
          {{ summary.coveredKCs }} of {{ summary.totalKCs }} skills observed ·
          {{ summary.domainsTouched }} of {{ summary.totalDomains }} domains<template v-if="summary.rusty > 0">
            · {{ summary.rusty }} going rusty</template>
        </div>
        <div v-if="weakSpots.length" class="weak-head mono">Weak spots — drill by hand</div>
        <div class="weak-rows">
          <div v-for="w in weakSpots" :key="w.id" class="weak-row">
            <span class="weak-label">{{ w.label }}</span>
            <span class="weak-reason mono muted">{{ w.reason }}</span>
            <button class="ghost small-btn" :disabled="drillBusy" @click="makeDrill(w)">Drill</button>
          </div>
        </div>
        <div v-if="!weakSpots.length" class="muted small" style="margin-top: 0.4rem">
          Nothing weak or rusty tracked yet. Solve more problems on the Pad.
        </div>
        <span v-if="drillError" class="muted small">Could not write one. Check the key or network.</span>
        <div v-if="drillBusy && !drill" class="muted small" style="margin-top: 0.5rem">Writing the drill…</div>
        <div v-if="drill" class="drill-problem">
          <div class="drill-task mono">{{ drill.task }} <span class="muted">· {{ drill.skillLabel }}</span></div>
          <MathText :text="drill.problem" class="drill-math" />
          <div class="drill-actions">
            <button class="ghost small-btn" @click="toPad">Pin on the pad</button>
            <button class="ghost small-btn" :disabled="drillBusy" @click="makeDrill()">Another one</button>
            <span class="muted small">Copy it onto the pad; grading picks it up like any problem.</span>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="empty">
      No solved problems yet. Work problems on the Pad; the weak-spot list builds from the
      skills your graded pages actually exercised, and each row hands you a drill on demand.
    </div>
  </section>
</template>

<style scoped>
.sum-row {
  font-size: 0.7rem;
  margin-bottom: 0.8rem;
}

.drill-problem {
  margin-top: 0.6rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--panel-2);
}

.drill-task {
  font-size: 0.72rem;
  color: var(--muted);
  margin-bottom: 0.25rem;
}

.drill-math {
  font-size: 1rem;
}

.drill-actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-top: 0.5rem;
  flex-wrap: wrap;
}

.weak-head {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  margin-bottom: 0.55rem;
}

.weak-rows {
  display: flex;
  flex-direction: column;
}

.weak-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.35rem 0;
  font-size: 0.85rem;
}

.weak-row + .weak-row {
  border-top: 1px solid var(--border);
}

.weak-label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.weak-reason {
  font-size: 0.68rem;
  flex: none;
}

.small-btn {
  padding: 0.2rem 0.6rem;
  font-size: 0.72rem;
}

.small {
  font-size: 0.74rem;
}
</style>
