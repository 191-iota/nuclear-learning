<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  domainRollup,
  rankings,
  recommendPractice,
  skillSummary,
  trajectory,
  overallTrajectory,
  resetSkills,
  type DomainRollup,
} from '@/stores/skills';

// Sentinel domain key for the aggregated "all touched domains" trajectory.
const OVERALL = '__all__';

// All reactive off the skill store: reading the selectors inside a computed registers
// the dependency, so the dashboard recomputes live as problems resolve.
const summary = computed(() => skillSummary());
const domains = computed(() => domainRollup());
const touchedDomains = computed(() => domains.value.filter((d) => d.touched > 0));
const ranks = computed(() => rankings());
const rec = computed(() => recommendPractice());

const selectedDomain = ref(OVERALL);
const traj = computed(() =>
  selectedDomain.value === OVERALL
    ? overallTrajectory()
    : selectedDomain.value
      ? trajectory(selectedDomain.value)
      : [],
);

// Mastery trajectory as a line. y is the 0-100 mastery index, so y = 100 - pct maps
// straight into the 0..100 viewBox; x is evenly spaced across the days.
const VW = 1000;
const VH = 100;
const trajPts = computed(() => {
  const t = traj.value;
  const n = t.length;
  return t.map((p, i) => ({ x: n <= 1 ? VW : (i / (n - 1)) * VW, y: VH - p.masteryPct }));
});
const trajLine = computed(() =>
  trajPts.value.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '),
);
const trajArea = computed(() => {
  const ps = trajPts.value;
  if (ps.length < 2) return '';
  return `M${ps[0].x.toFixed(1)},${VH} ${trajLine.value.slice(1)} L${ps[ps.length - 1].x.toFixed(1)},${VH} Z`;
});

function reset() {
  if (confirm('Reset all tracked skill mastery? This cannot be undone.')) {
    resetSkills();
    selectedDomain.value = OVERALL;
  }
}

function pct(n: number | null): string {
  return n === null ? '—' : `${n}%`;
}
function domTip(d: DomainRollup): string {
  const m = d.masteryPct === null ? 'not assessed' : `${d.masteryPct}% index`;
  return `${d.label}\n${m} · ${d.touched}/${d.total} skills`;
}
</script>

<template>
  <section class="scroll">
    <div class="page-head">
      <h2>Progress</h2>
      <span class="muted mono" style="font-size: 0.72rem">
        {{ summary.coveredKCs }}/{{ summary.totalKCs }} skills · {{ summary.domainsTouched }}/{{
          summary.totalDomains
        }} domains
      </span>
      <span class="spacer" />
      <button v-if="summary.coveredKCs > 0" class="ghost danger" @click="reset">Reset</button>
    </div>

    <template v-if="summary.coveredKCs > 0">
      <div v-if="rec.drill || rec.review" class="card rec">
        <div class="rec-head mono">Practice next</div>
        <div v-if="rec.drill" class="rec-line">
          <span class="rec-tag">Work on</span>
          <strong>{{ rec.drill.label }}</strong>
          <span class="muted"> — your weakest tracked skill, {{ rec.drill.masteryPct }}% index</span>
        </div>
        <div v-if="rec.review" class="rec-line">
          <span class="rec-tag review">Refresh</span>
          <strong>{{ rec.review.label }}</strong>
          <span class="muted"> — strong but fading, last worked {{ rec.review.daysSince }}d ago</span>
        </div>
        <div class="muted small rec-aim">
          Pick problems you would get right about 4 times in 5 — hard enough to stretch, not to stall.
        </div>
      </div>

      <div class="stat-grid">
        <div class="card stat">
          <div class="k">Coverage</div>
          <div class="v">{{ summary.coveredKCs }}/{{ summary.totalKCs }}</div>
          <div class="sub">{{ summary.domainsTouched }} of {{ summary.totalDomains }} domains</div>
        </div>
        <div class="card stat">
          <div class="k">Strongest area</div>
          <div class="v area">{{ summary.strongest ? summary.strongest.label : '—' }}</div>
          <div class="sub">{{ summary.strongest ? pct(summary.strongest.masteryPct) + ' index' : '' }}</div>
        </div>
        <div class="card stat">
          <div class="k">Weakest area</div>
          <div class="v area">{{ summary.weakest ? summary.weakest.label : '—' }}</div>
          <div class="sub">{{ summary.weakest ? pct(summary.weakest.masteryPct) + ' index' : '' }}</div>
        </div>
        <div class="card stat">
          <div class="k">Getting rusty</div>
          <div class="v">{{ summary.rusty }}</div>
          <div class="sub">strong but going stale</div>
        </div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom: 0.2rem">
          <strong style="font-size: 0.85rem">Mastery by domain</strong>
          <span class="spacer" />
          <span class="muted mono" style="font-size: 0.68rem">tap a bar to focus</span>
        </div>
        <div class="chart">
          <div
            v-for="d in domains"
            :key="d.domain"
            class="bar-col"
            :class="{ dim: d.masteryPct === null, sel: d.domain === selectedDomain }"
            :title="domTip(d)"
            @click="d.touched > 0 && (selectedDomain = d.domain)"
          >
            <div class="bar-track">
              <div class="seg-fill" :style="{ flexGrow: 100 - (d.masteryPct ?? 0) }" />
              <div class="seg-out" :style="{ flexGrow: d.masteryPct ?? 0 }" />
            </div>
            <div class="bar-label">{{ d.domain }}</div>
          </div>
        </div>
        <div class="legend">
          <span><span class="dot" style="background: var(--chart-out)" />mastery index (0-100)</span>
          <span class="muted">dim = not assessed yet</span>
        </div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom: 0.4rem">
          <strong style="font-size: 0.85rem">Mastery over time</strong>
          <span class="spacer" />
        </div>
        <div class="tabs domsel">
          <button
            class="tab"
            :class="{ active: selectedDomain === OVERALL }"
            @click="selectedDomain = OVERALL"
          >
            overall
          </button>
          <button
            v-for="d in touchedDomains"
            :key="d.domain"
            class="tab"
            :class="{ active: d.domain === selectedDomain }"
            @click="selectedDomain = d.domain"
          >
            {{ d.domain }}
          </button>
        </div>
        <template v-if="traj.length >= 2">
          <svg class="trend" :viewBox="`0 0 ${VW} ${VH}`" preserveAspectRatio="none" aria-hidden="true">
            <line class="t-grid" x1="0" :y1="VH / 2" :x2="VW" :y2="VH / 2" />
            <path :d="trajArea" class="t-area" />
            <path :d="trajLine" class="t-line" />
          </svg>
          <div class="t-axis mono">
            <span>{{ traj.length }} days</span>
            <span class="spacer" />
            <span>now {{ traj[traj.length - 1].masteryPct }}%</span>
          </div>
        </template>
        <p v-else class="muted" style="font-size: 0.72rem; margin-top: 0.6rem">
          A line builds here once there are two days of practice. Level is demonstrated mastery and
          stays sticky, so going rusty shows as the line drifting down, not a sudden drop.
        </p>
      </div>

      <div class="rank-grid">
        <div class="card rank">
          <div class="rank-head mono">Drill next</div>
          <div v-if="ranks.drill.length" class="rows">
            <div v-for="r in ranks.drill" :key="r.id" class="skillrow" :class="{ prov: r.provisional }">
              <span class="lbl" :title="r.id">{{ r.label }}</span>
              <span class="track"><span class="fill" :style="{ width: r.masteryPct + '%', opacity: 0.4 + 0.6 * r.R }" /></span>
              <span class="meta">{{ r.masteryPct }}%<template v-if="r.f >= 1"> · {{ r.f }}× missed</template></span>
            </div>
          </div>
          <div v-else class="muted small">Nothing weak enough to flag yet.</div>
        </div>

        <div class="card rank">
          <div class="rank-head mono">Strongest</div>
          <div v-if="ranks.strongest.length" class="rows">
            <div v-for="r in ranks.strongest" :key="r.id" class="skillrow">
              <span class="lbl" :title="r.id">{{ r.label }}</span>
              <span class="track"><span class="fill good" :style="{ width: r.masteryPct + '%', opacity: 0.4 + 0.6 * r.R }" /></span>
              <span class="meta">{{ r.masteryPct }}%</span>
            </div>
          </div>
          <div v-else class="muted small">Solve a few more to confirm a strength.</div>
        </div>

        <div class="card rank">
          <div class="rank-head mono">Fading review</div>
          <div v-if="ranks.fading.length" class="rows">
            <div v-for="r in ranks.fading" :key="r.id" class="skillrow">
              <span class="lbl" :title="r.id">{{ r.label }}</span>
              <span class="track"><span class="fill" :style="{ width: r.masteryPct + '%', opacity: 0.4 + 0.6 * r.R }" /></span>
              <span class="meta">{{ r.daysSince }}d ago</span>
            </div>
          </div>
          <div v-else class="muted small">Nothing going stale.</div>
        </div>
      </div>

      <p class="muted" style="font-size: 0.72rem; margin-top: 0.8rem">
        Each solved problem is tagged once against a fixed map of 125 math skills and folded into a
        local rating, so this updates live and costs no extra request. A skill rises with clean work,
        dips on a miss, and fades when left untouched. Numbers are a mastery index, not a percentage
        correct.
      </p>
    </template>

    <div v-else class="empty">
      No solved problems assessed yet. Work problems on the Pad in a math mode. Once one resolves, the
      skills it exercised show up here, and a picture of your strengths and weak spots builds over time.
    </div>
  </section>
</template>

<style scoped>
.stat .v.area {
  font-size: 1rem;
  line-height: 1.2;
}

.bar-col.dim .bar-track {
  opacity: 0.4;
}
.bar-col.sel .bar-label {
  color: var(--ink);
  font-weight: 600;
}
.bar-col {
  cursor: pointer;
}

.domsel {
  flex-wrap: wrap;
  gap: 0.3rem;
}
.domsel .tab {
  padding: 0.25rem 0.55rem;
  font-size: 0.72rem;
}

.rec {
  border-left: 3px solid var(--gold);
}
.rec-head {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  margin-bottom: 0.5rem;
}
.rec-line {
  font-size: 0.82rem;
  margin: 0.25rem 0;
}
.rec-tag {
  display: inline-block;
  min-width: 4.2rem;
  font-family: var(--mono);
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--gold);
  margin-right: 0.35rem;
}
.rec-tag.review {
  color: var(--muted);
}
.rec-aim {
  margin-top: 0.45rem;
}

.rank-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
  gap: 0.7rem;
  margin-top: 1rem;
}

.rank-head {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
  margin-bottom: 0.6rem;
}

.rows {
  display: flex;
  flex-direction: column;
}

.skillrow {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.32rem 0;
  font-family: var(--mono);
  font-size: 0.72rem;
}
.skillrow.prov {
  opacity: 0.6;
}
.skillrow .lbl {
  flex: 0 0 8.5rem;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.skillrow .track {
  flex: 1;
  height: 0.5rem;
  background: var(--panel-2);
  border-radius: 3px;
  overflow: hidden;
}
.skillrow .fill {
  display: block;
  height: 100%;
  background: var(--gold);
}
.skillrow .fill.good {
  background: var(--good);
}
.skillrow .meta {
  flex: 0 0 auto;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.small {
  font-size: 0.74rem;
}

.trend {
  width: 100%;
  height: 150px;
  display: block;
  margin-top: 0.5rem;
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
</style>
