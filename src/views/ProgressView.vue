<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  domainRollup,
  rankings,
  skillSummary,
  trajectory,
  resetSkills,
  type DomainRollup,
} from '@/stores/skills';

// All reactive off the skill store: reading the selectors inside a computed registers
// the dependency, so the dashboard recomputes live as problems resolve.
const summary = computed(() => skillSummary());
const domains = computed(() => domainRollup());
const touchedDomains = computed(() => domains.value.filter((d) => d.touched > 0));
const ranks = computed(() => rankings());

const selectedDomain = ref('');
const traj = computed(() => (selectedDomain.value ? trajectory(selectedDomain.value) : []));

onMounted(() => {
  // Open on the weakest touched domain, so the trajectory and lists are populated.
  selectedDomain.value = summary.value.weakest?.domain ?? touchedDomains.value[0]?.domain ?? '';
});

function reset() {
  if (confirm('Reset all tracked skill mastery? This cannot be undone.')) {
    resetSkills();
    selectedDomain.value = '';
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
            v-for="d in touchedDomains"
            :key="d.domain"
            class="tab"
            :class="{ active: d.domain === selectedDomain }"
            @click="selectedDomain = d.domain"
          >
            {{ d.domain }}
          </button>
        </div>
        <div v-if="traj.length >= 2" class="chart" style="margin-top: 0.6rem">
          <div v-for="(p, i) in traj" :key="i" class="bar-col" :title="`+${i}d · ${p.masteryPct}%`">
            <div class="bar-track">
              <div class="seg-fill" :style="{ flexGrow: 100 - p.masteryPct }" />
              <div class="seg-out" :style="{ flexGrow: p.masteryPct }" />
            </div>
            <div class="bar-label">{{ i === traj.length - 1 ? 'now' : '' }}</div>
          </div>
        </div>
        <p v-else class="muted" style="font-size: 0.72rem; margin-top: 0.6rem">
          Not enough history yet for a trajectory. Each bar will be one day. Level is demonstrated
          mastery and stays sticky, so going rusty shows as fading rather than a falling bar.
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
</style>
