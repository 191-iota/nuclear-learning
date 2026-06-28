<script setup lang="ts">
import { computed, ref } from 'vue';
import { perPage, usageSummary, clearUsage, type PageStat } from '@/stores/usage';
import { settings } from '@/stores/settings';

type Metric = 'cost' | 'tokens';
const metric = ref<Metric>('cost');

// These read reactive sources (usage records + settings prices) so they recompute
// live as scans land and as you change the model/prices in Presets.
const summary = computed(() => usageSummary());
const stats = computed(() => perPage());

const maxVal = computed(() =>
  Math.max(
    1e-9,
    ...stats.value.map((s) => (metric.value === 'cost' ? s.costUSD : s.input + s.output)),
  ),
);

function segOut(s: PageStat): number {
  return metric.value === 'cost' ? s.outputCostUSD : s.output;
}
function segIn(s: PageStat): number {
  return metric.value === 'cost' ? s.inputCostUSD : s.input;
}
function fill(s: PageStat): number {
  return Math.max(0, maxVal.value - segOut(s) - segIn(s));
}
// Normalise to flex-grow factors that sum to 100 per bar, keeps proportions and
// avoids the CSS rule where grow factors summing to < 1 don't fill the track.
function grow(v: number): number {
  return (v / maxVal.value) * 100;
}

function usd(n: number): string {
  return '$' + (n >= 1 ? n.toFixed(2) : n.toFixed(3));
}
function tok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
function tip(s: PageStat): string {
  return (
    `Page ${s.page} · ${s.scans} scans (${s.solves} solve / ${s.verifies} verify)\n` +
    `${tok(s.input)} in · ${tok(s.output)} out · ${usd(s.costUSD)}`
  );
}
</script>

<template>
  <section class="scroll">
    <div class="page-head">
      <h2>Usage</h2>
      <span class="muted mono" style="font-size: 0.72rem">
        solve {{ settings.api.solveModel.replace('claude-', '') }} · verify
        {{ settings.api.verifyModel.replace('claude-', '') }}
      </span>
      <span class="spacer" />
      <div class="tabs">
        <button class="tab" :class="{ active: metric === 'cost' }" @click="metric = 'cost'">
          Cost
        </button>
        <button class="tab" :class="{ active: metric === 'tokens' }" @click="metric = 'tokens'">
          Tokens
        </button>
      </div>
      <button class="ghost danger" @click="clearUsage">Clear log</button>
    </div>

    <template v-if="summary.scans > 0">
      <div class="stat-grid">
        <div class="card stat">
          <div class="k">Est. cost</div>
          <div class="v">{{ usd(summary.estCostUSD) }}</div>
          <div class="sub">{{ usd(summary.costPerPageUSD) }} / page</div>
        </div>
        <div class="card stat">
          <div class="k">Tokens</div>
          <div class="v">{{ tok(summary.tokensTotal) }}</div>
          <div class="sub">{{ tok(summary.totals.input) }} in · {{ tok(summary.totals.output) }} out</div>
        </div>
        <div class="card stat">
          <div class="k">Tokens / scan</div>
          <div class="v">{{ tok(summary.tokensPerScan) }}</div>
          <div class="sub">{{ summary.scans }} scans · {{ summary.pages }} pages</div>
        </div>
        <div class="card stat">
          <div class="k">Solve : verify</div>
          <div class="v">{{ summary.totals.solves }} : {{ summary.totals.verifies }}</div>
          <div class="sub">cheap verifies vs full solves</div>
        </div>
      </div>

      <div class="card">
        <div class="row" style="margin-bottom: 0.2rem">
          <strong style="font-size: 0.85rem">{{ metric === 'cost' ? 'Cost' : 'Tokens' }} per page</strong>
          <span class="spacer" />
        </div>
        <div class="chart">
          <div v-for="s in stats" :key="s.page" class="bar-col" :title="tip(s)">
            <div class="bar-track">
              <div class="seg-fill" :style="{ flexGrow: grow(fill(s)) }" />
              <div class="seg seg-out" :style="{ flexGrow: grow(segOut(s)) }" />
              <div class="seg seg-in" :style="{ flexGrow: grow(segIn(s)) }" />
            </div>
            <div class="bar-label">{{ s.page }}</div>
          </div>
        </div>
        <div class="legend">
          <span><span class="dot" style="background: var(--chart-in)" />Input (image + prompt, cheap)</span>
          <span><span class="dot" style="background: var(--chart-out)" />Output (thinking + verdict, 5× price)</span>
        </div>
      </div>

      <p class="muted" style="font-size: 0.72rem; margin-top: 0.8rem">
        Each bar is one Clear-to-Clear page. Updates live as you write. Prices come from the model
        rates in Presets, so changing model there re-prices history instantly.
      </p>
    </template>

    <div v-else class="empty">
      No scans recorded yet. Connect the pen and write on the Pad. Usage shows up here live.
    </div>
  </section>
</template>
