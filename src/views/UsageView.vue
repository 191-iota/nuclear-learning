<script setup lang="ts">
import ConfirmButton from '@/components/ConfirmButton.vue';
import { computed } from 'vue';
import {
  usage,
  perProblemBars,
  usageSummary,
  byRole,
  byModel,
  clearUsage,
  type ProblemBar,
} from '@/stores/usage';

// All reactive off the usage records, so everything recomputes live as scans land.
const summary = computed(() => usageSummary());
// One column per problem while there are few; once there are more problems than the bar
// budget, neighbouring problems fold into a column so the chart keeps its width and shape
// however long you use it. The per-problem read (and the input/output split) survives.
const bars = computed(() => perProblemBars(48));
const grouped = computed(() => bars.value.some((b) => b.problems > 1));
const roles = computed(() => byRole());
const models = computed(() => byModel());
const hasRecords = computed(() => usage.records.length > 0);

const maxVal = computed(() => Math.max(1, ...bars.value.map((s) => s.tokens)));

function fill(s: ProblemBar): number {
  return Math.max(0, maxVal.value - s.tokens);
}
function grow(v: number): number {
  return (v / maxVal.value) * 100;
}

function tok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function share(tokens: number): number {
  return summary.value.tokensTotal > 0 ? (tokens / summary.value.tokensTotal) * 100 : 0;
}
function barRange(s: ProblemBar): string {
  return s.problems > 1 ? `Problems ${s.fromPage}-${s.toPage}` : `Problem ${s.fromPage}`;
}
function tip(s: ProblemBar): string {
  return `${barRange(s)} · ${s.scans} scans\n${tok(s.input)} in · ${tok(s.output)} out`;
}

function clearLog(): void {
  if (hasRecords.value) clearUsage();
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
      <span class="muted mono" style="font-size: 0.72rem">tokens read and written, per model</span>
      <span class="spacer" />
      <ConfirmButton ghost label="Clear log" :disabled="!hasRecords" title="Delete every usage record" @confirm="clearLog" />
    </div>

    <template v-if="summary.scans > 0">
      <div class="stat-grid">
        <div class="card stat">
          <div class="k">Tokens</div>
          <div class="v">{{ tok(summary.tokensTotal) }}</div>
          <div class="sub">{{ tok(summary.totals.input) }} in · {{ tok(summary.totals.output) }} out</div>
        </div>
        <div class="card stat">
          <div class="k">Per problem</div>
          <div class="v">{{ tok(summary.tokensPerPage) }}</div>
          <div class="sub">{{ tok(summary.tokensPerScan) }} / scan</div>
        </div>
        <div class="card stat">
          <div class="k">Scans</div>
          <div class="v">{{ summary.scans }}</div>
          <div class="sub">{{ summary.pages }} problems</div>
        </div>
        <div class="card stat">
          <div class="k">Lesson cards</div>
          <div class="v">{{ summary.lessons.count }}</div>
          <div class="sub">{{ tok(summary.lessons.tokens) }} tokens</div>
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
            <span class="utrack"><span class="ufill" :style="{ width: share(r.tokens) + '%' }" /></span>
            <span class="uamount mono">{{ tok(r.tokens) }}</span>
          </div>
        </div>
        <div
          class="userows"
          style="margin-top: 0.8rem; border-top: 1px solid var(--border); padding-top: 0.7rem"
        >
          <div v-for="m in models" :key="m.model" class="userow">
            <span class="ulabel">{{ m.label }}</span>
            <span class="ucount muted mono">{{ m.count }}×</span>
            <span class="utrack"><span class="ufill model" :style="{ width: share(m.tokens) + '%' }" /></span>
            <span class="uamount mono">{{ tok(m.tokens) }}</span>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom: 0.2rem">
          <strong style="font-size: 0.85rem">Tokens per problem</strong>
          <span v-if="grouped" class="muted mono" style="font-size: 0.68rem; margin-left: 0.5rem"
            >grouped to fit</span
          >
        </div>
        <div class="chart">
          <div v-for="(s, i) in bars" :key="s.fromPage" class="bar-col" :title="tip(s)">
            <div class="bar-track">
              <div class="seg-fill" :style="{ flexGrow: grow(fill(s)) }" />
              <div class="seg seg-out" :style="{ flexGrow: grow(s.output) }" />
              <div class="seg seg-in" :style="{ flexGrow: grow(s.input) }" />
            </div>
            <div class="bar-label">{{ barLabel(s, i) }}</div>
          </div>
        </div>
        <div class="legend">
          <span><span class="dot" style="background: var(--chart-in)" />Input (image + prompt)</span>
          <span><span class="dot" style="background: var(--chart-out)" />Output (thinking + reply)</span>
        </div>
      </div>

      <p class="usage-note muted">
        Each bar covers one Clear-to-Clear problem and splits what the model read from what it
        wrote. Long histories group neighbouring problems to keep the chart readable. Nothing here
        is billed: every request is answered by Ollama on this machine, so what the numbers measure
        is how much work each page made, and roughly how long it kept you waiting.
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

.userow .uamount {
  flex: 0 0 3.6rem;
  text-align: right;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.usage-note {
  max-width: 72rem;
  font-size: 0.72rem;
  line-height: 1.5;
  margin: 0.8rem 0 0;
}
</style>
