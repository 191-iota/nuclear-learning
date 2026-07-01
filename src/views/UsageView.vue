<script setup lang="ts">
import { computed, ref } from 'vue';
import { perProblemBars, usageSummary, byRole, byModel, clearUsage, type ProblemBar } from '@/stores/usage';

type Metric = 'cost' | 'tokens';
const metric = ref<Metric>('cost');

// All reactive off the usage records + the model prices, so everything recomputes
// live as scans land and as you change a model or its price in Presets.
const summary = computed(() => usageSummary());
// One column per problem while there are few; once there are more problems than the bar
// budget, neighbouring problems fold into a column so the chart keeps its width and shape
// however long you use it. The per-problem read (and the input/output split) survives.
const bars = computed(() => perProblemBars(48));
const grouped = computed(() => bars.value.some((b) => b.problems > 1));
const roles = computed(() => byRole());
const models = computed(() => byModel());

const maxVal = computed(() =>
  Math.max(
    1e-9,
    ...bars.value.map((s) => (metric.value === 'cost' ? s.costUSD : s.input + s.output)),
  ),
);

function segOut(s: ProblemBar): number {
  return metric.value === 'cost' ? s.outputCostUSD : s.output;
}
function segIn(s: ProblemBar): number {
  return metric.value === 'cost' ? s.inputCostUSD : s.input;
}
function fill(s: ProblemBar): number {
  return Math.max(0, maxVal.value - segOut(s) - segIn(s));
}
function grow(v: number): number {
  return (v / maxVal.value) * 100;
}

function usd(n: number): string {
  return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(3));
}
function tok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function share(costUSD: number): number {
  return summary.value.estCostUSD > 0 ? (costUSD / summary.value.estCostUSD) * 100 : 0;
}
function barRange(s: ProblemBar): string {
  return s.problems > 1 ? `Problems ${s.fromPage}-${s.toPage}` : `Problem ${s.fromPage}`;
}
function tip(s: ProblemBar): string {
  return `${barRange(s)} · ${s.scans} scans\n${tok(s.input)} in · ${tok(s.output)} out · ${usd(s.costUSD)}`;
}
// Under-bar numbers: label every column when they are single problems and few enough to
// read, otherwise anchor just the first and last so the axis stays clean.
function barLabel(s: ProblemBar, i: number): string {
  if (bars.value.length <= 20 && s.problems === 1) return String(s.fromPage);
  if (i === 0) return `#${s.fromPage}`;
  if (i === bars.value.length - 1) return 'latest';
  return '';
}
</script>

<template>
  <section class="scroll">
    <div class="page-head">
      <h2>Usage</h2>
      <span class="muted mono" style="font-size: 0.72rem">estimated, priced per model</span>
      <span class="spacer" />
      <button class="ghost danger" @click="clearUsage">Clear log</button>
    </div>

    <template v-if="summary.scans > 0">
      <div class="stat-grid">
        <div class="card stat">
          <div class="k">Est. cost</div>
          <div class="v">{{ usd(summary.estCostUSD) }}</div>
          <div class="sub">{{ usd(summary.costPerPageUSD) }} / problem</div>
        </div>
        <div class="card stat">
          <div class="k">Tokens</div>
          <div class="v">{{ tok(summary.tokensTotal) }}</div>
          <div class="sub">{{ tok(summary.totals.input) }} in · {{ tok(summary.totals.output) }} out</div>
        </div>
        <div class="card stat">
          <div class="k">Scans</div>
          <div class="v">{{ summary.scans }}</div>
          <div class="sub">{{ summary.pages }} problems</div>
        </div>
        <div class="card stat">
          <div class="k">Lesson cards</div>
          <div class="v">{{ usd(summary.lessons.costUSD) }}</div>
          <div class="sub">{{ summary.lessons.count }} written</div>
        </div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom: 0.6rem">
          <strong style="font-size: 0.85rem">Where it goes</strong>
          <span class="spacer" />
          <span class="muted mono" style="font-size: 0.68rem">by purpose, then by model</span>
        </div>
        <div class="userows">
          <div v-for="r in roles" :key="r.role" class="userow">
            <span class="ulabel">{{ r.label }}</span>
            <span class="ucount muted mono">{{ r.count }}×</span>
            <span class="utrack"><span class="ufill" :style="{ width: share(r.costUSD) + '%' }" /></span>
            <span class="ucost mono">{{ usd(r.costUSD) }}</span>
          </div>
        </div>
        <div
          class="userows"
          style="margin-top: 0.8rem; border-top: 1px solid var(--border); padding-top: 0.7rem"
        >
          <div v-for="m in models" :key="m.model" class="userow">
            <span class="ulabel">{{ m.label }}</span>
            <span class="ucount muted mono">{{ m.count }}×</span>
            <span class="utrack"><span class="ufill model" :style="{ width: share(m.costUSD) + '%' }" /></span>
            <span class="ucost mono">{{ usd(m.costUSD) }}</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom: 0.2rem">
          <strong style="font-size: 0.85rem">{{ metric === 'cost' ? 'Cost' : 'Tokens' }} per problem</strong>
          <span v-if="grouped" class="muted mono" style="font-size: 0.68rem; margin-left: 0.5rem"
            >grouped to fit</span
          >
          <span class="spacer" />
          <div class="tabs">
            <button class="tab" :class="{ active: metric === 'cost' }" @click="metric = 'cost'">Cost</button>
            <button class="tab" :class="{ active: metric === 'tokens' }" @click="metric = 'tokens'">Tokens</button>
          </div>
        </div>
        <div class="chart">
          <div v-for="(s, i) in bars" :key="s.fromPage" class="bar-col" :title="tip(s)">
            <div class="bar-track">
              <div class="seg-fill" :style="{ flexGrow: grow(fill(s)) }" />
              <div class="seg seg-out" :style="{ flexGrow: grow(segOut(s)) }" />
              <div class="seg seg-in" :style="{ flexGrow: grow(segIn(s)) }" />
            </div>
            <div class="bar-label">{{ barLabel(s, i) }}</div>
          </div>
        </div>
        <div class="legend">
          <span><span class="dot" style="background: var(--chart-in)" />Input (image + prompt)</span>
          <span><span class="dot" style="background: var(--chart-out)" />Output (thinking + reply)</span>
        </div>
      </div>

      <p class="muted" style="font-size: 0.72rem; margin-top: 0.8rem">
        Each bar is one Clear-to-Clear problem, split into the input it sent and the output it got
        back, priced from the model rates in Presets so changing a model re-prices history instantly.
        Once you have done more problems than fit across the chart, neighbouring problems are grouped
        into one bar so it keeps its width and shape however long you use it, and the lifetime totals
        stay in the cards above. A strong model solves and signs off while a cheaper one runs the
        repetitive middle checks. Solve and confirm also carry the skill tagging that feeds Progress, so
        it rides those rows rather than adding its own; lesson cards are the one separate call, on
        Sonnet, written once per mistake you fix.
      </p>
    </template>

    <div v-else class="empty">
      No scans recorded yet. Connect the pen and write on the Pad. Usage shows up here live.
    </div>
  </section>
</template>

<style scoped>
.userows {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}

.userow {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  font-size: 0.76rem;
}

.userow .ulabel {
  flex: 0 0 6.5rem;
  color: var(--ink);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.userow .ucount {
  flex: 0 0 2.6rem;
  font-size: 0.7rem;
  text-align: right;
}

.userow .utrack {
  flex: 1;
  height: 0.55rem;
  background: var(--panel-2);
  border-radius: 3px;
  overflow: hidden;
}

.userow .ufill {
  display: block;
  height: 100%;
  background: var(--chart-out);
}

.userow .ufill.model {
  background: var(--chart-in);
}

.userow .ucost {
  flex: 0 0 3.6rem;
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
</style>
