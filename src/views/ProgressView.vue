<script setup lang="ts">
import { computed, ref } from 'vue';
import { rankings, skillSummary, ratingHistory, resetSkills } from '@/stores/skills';
import { generateDrill, type DrillProblem } from '@/drill';
import { rankView, rankDrillTarget, RANKS } from '@/rank';
import MathText from '@/components/MathText.vue';

// The tab answers exactly two questions: how am I progressing (rating, delta, curve,
// distance to the next rank) and what should I drill (weakest skills, one button each).
// Everything percentage-shaped was cut on purpose — the rating is the score, the skill
// map stays an internal diagnostic feeding the weak-spot list and the drill targeting.

const summary = computed(() => skillSummary());
const rank = computed(() => rankView());

// The rating curve: one point per active day, x proportional to the calendar so a
// break renders as a flat gap and the slope stays an honest per-time signal.
const VW = 1000;
const VH = 100;
const curve = computed(() => ratingHistory());
const curvePts = computed(() => {
  const h = curve.value;
  if (h.length < 2) return [];
  const lo = Math.min(...h.map((s) => s.r));
  const hi = Math.max(...h.map((s) => s.r));
  const pad = Math.max(40, (hi - lo) * 0.15);
  const a = h[0].day;
  const b = h[h.length - 1].day;
  return h.map((s) => ({
    x: (b === a ? 1 : (s.day - a) / (b - a)) * VW,
    y: VH - ((s.r - (lo - pad)) / (hi - lo + 2 * pad)) * VH,
  }));
});
const curveLine = computed(() =>
  curvePts.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
);
const curveArea = computed(() => {
  const ps = curvePts.value;
  if (ps.length < 2) return '';
  return `M${ps[0].x.toFixed(1)},${VH} ${curveLine.value.slice(1)} L${ps[ps.length - 1].x.toFixed(1)},${VH} Z`;
});

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
    if (out.length >= 5) break;
  }
  return out;
});

const drill = ref<DrillProblem | null>(null);
const drillBusy = ref(false);
const drillError = ref(false);
async function makeDrill(target?: { id: string; masteryPct: number }) {
  const t = target ?? rankDrillTarget() ?? weakSpots.value[0];
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

function reset() {
  if (confirm('Reset all tracked skill mastery and the rating? This cannot be undone.')) {
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
      <div class="card rankcard">
        <div class="rank-row">
          <div class="rank-badge mono">{{ rank.rank.n }}</div>
          <div>
            <div class="rank-title">{{ rank.rank.title }}</div>
            <div class="rank-anchor muted">rank {{ rank.rank.n }} of {{ RANKS.length }} · {{ rank.rank.anchor }}</div>
          </div>
          <span class="spacer" />
          <div v-if="rank.rating" class="rating-wrap">
            <div class="rating-num mono">
              {{ rank.rating.value }}<span v-if="rank.rating.provisional" class="rating-pm">?</span>
            </div>
            <div class="rating-sub mono muted">
              <template v-if="rank.rating.provisional">
                ±{{ rank.rating.pm }} · {{ rank.rating.n }} problem{{ rank.rating.n === 1 ? '' : 's' }}
              </template>
              <template v-else-if="rank.rating.weekDelta !== null">
                <span :class="rank.rating.weekDelta >= 0 ? 'delta-up' : 'delta-down'">
                  {{ rank.rating.weekDelta >= 0 ? '▲' : '▼' }} {{ Math.abs(rank.rating.weekDelta) }}
                </span>
                this week
              </template>
              <template v-else>rating · {{ rank.rating.n }} problems</template>
            </div>
          </div>
          <div class="rank-dots" aria-hidden="true">
            <span
              v-for="r in RANKS"
              :key="r.n"
              class="dot"
              :class="{ held: r.n <= rank.rank.n }"
              :title="`${r.title} · ${r.minRating}+`"
            />
          </div>
        </div>

        <template v-if="curvePts.length >= 2">
          <svg class="trend" :viewBox="`0 0 ${VW} ${VH}`" preserveAspectRatio="none" aria-hidden="true">
            <line class="t-grid" x1="0" :y1="VH / 2" :x2="VW" :y2="VH / 2" />
            <path :d="curveArea" class="t-area" />
            <path :d="curveLine" class="t-line" />
          </svg>
          <div class="t-axis mono">
            <span>from {{ curve[0].r }}</span>
            <span class="spacer" />
            <span>now {{ curve[curve.length - 1].r }}</span>
          </div>
        </template>
        <p v-else class="muted small" style="margin: 0.8rem 0 0.2rem">
          Your rating curve starts drawing after the second active day.
        </p>

        <div v-if="rank.next" class="gate-row">
          <span class="gate-line muted">to {{ rank.next.title }}</span>
          <span class="gate-track"><span class="fill" :style="{ width: rank.nextProgress + '%' }" /></span>
          <span class="gate-line">{{ rank.next.minRating - (rank.rating?.value ?? 0) }} rating</span>
          <button class="ghost" :disabled="drillBusy" @click="makeDrill()">
            {{ drillBusy ? 'Writing…' : drill ? 'Another one' : 'Drill one' }}
          </button>
          <span v-if="drillError" class="muted small">couldn't write one — check the key / network</span>
        </div>
        <div v-if="drill" class="drill-problem">
          <div class="drill-task mono">{{ drill.task }} <span class="muted">· {{ drill.skillLabel }}</span></div>
          <MathText :text="drill.problem" class="drill-math" />
          <div class="muted small" style="margin-top: 0.3rem">
            Copy it onto the pad — grading picks it up like any problem.
          </div>
        </div>
      </div>

      <div v-if="weakSpots.length" class="card">
        <div class="weak-head mono">Weak spots</div>
        <div class="weak-rows">
          <div v-for="w in weakSpots" :key="w.id" class="weak-row">
            <span class="weak-label">{{ w.label }}</span>
            <span class="weak-reason mono muted">{{ w.reason }}</span>
            <button class="ghost small-btn" :disabled="drillBusy" @click="makeDrill(w)">Drill</button>
          </div>
        </div>
        <div class="muted small" style="margin-top: 0.55rem">
          Fixing a weak spot is also the cheapest rating you'll ever gain.
        </div>
      </div>
    </template>

    <div v-else class="empty">
      No solved problems yet. Work problems on the Pad — after a handful you get a rating, and your
      curve and weak spots build from there.
    </div>
  </section>
</template>

<style scoped>
.rankcard {
  border-left: 3px solid var(--gold);
  margin-bottom: 0.7rem;
  padding-bottom: 0.9rem;
}

.rank-row {
  display: flex;
  align-items: center;
  gap: 0.9rem;
  flex-wrap: wrap; /* rating + dots drop to a second line on narrow screens */
}

.rank-badge {
  width: 2.8rem;
  height: 2.8rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 2px solid var(--gold);
  border-radius: 50%;
  font-size: 1.25rem;
  color: var(--gold);
  flex: none;
}

.rank-title {
  font-size: 1.3rem;
  font-weight: 650;
  letter-spacing: 0.01em;
  line-height: 1.15;
}

.rank-anchor {
  font-size: 0.76rem;
}

/* The rating: THE number. */
.rating-wrap {
  text-align: right;
  margin-right: 1.1rem;
}

.rating-num {
  font-size: 1.7rem;
  line-height: 1.05;
  color: var(--gold);
  font-variant-numeric: tabular-nums;
}

.rating-pm {
  font-size: 1rem;
  color: var(--muted);
}

.rating-sub {
  font-size: 0.64rem;
}

.delta-up {
  color: var(--good);
}

.delta-down {
  color: var(--muted);
}

/* The six-rank ladder at a glance: held ranks are lit. */
.rank-dots {
  display: flex;
  gap: 0.4rem;
  align-items: center;
}

.rank-dots .dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  border: 1.5px solid var(--border);
  background: transparent;
}

.rank-dots .dot.held {
  border-color: var(--gold);
  background: var(--gold);
}

.trend {
  width: 100%;
  height: 150px;
  display: block;
  margin-top: 1rem;
}

.t-grid {
  stroke: var(--border);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}

.t-area {
  fill: var(--gold);
  opacity: 0.13;
}

.t-line {
  fill: none;
  stroke: var(--gold);
  stroke-width: 2;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.t-axis {
  display: flex;
  font-size: 0.66rem;
  color: var(--muted);
  margin-top: 0.35rem;
}

.gate-row {
  display: flex;
  align-items: center;
  gap: 0.8rem;
  margin-top: 0.9rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--border);
  flex-wrap: wrap;
}

.gate-line {
  font-size: 0.82rem;
}

.gate-track {
  flex: 0 0 7rem;
  height: 0.4rem;
  background: var(--panel-2);
  border-radius: 3px;
  overflow: hidden;
}

.gate-track .fill {
  display: block;
  height: 100%;
  background: var(--gold);
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
