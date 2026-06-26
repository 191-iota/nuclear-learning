<script setup lang="ts">
import { modes, addMode, removeMode, resetModes } from '@/stores/modes';
import { settings, resetSettings } from '@/stores/settings';

const MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8', in: 5, out: 25 },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', in: 5, out: 25 },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', in: 3, out: 15 },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5', in: 1, out: 5 },
];
const EFFORTS = ['low', 'medium', 'high', 'max'];
const STYLES = ['spoken', 'chime', 'both'];

// When the model changes, drop in its list prices so the Usage chart stays honest.
function onModelChange(): void {
  const m = MODELS.find((x) => x.id === settings.api.model);
  if (m) {
    settings.api.priceInputPerMTok = m.in;
    settings.api.priceOutputPerMTok = m.out;
  }
}
</script>

<template>
  <section class="scroll">
    <div class="config-wrap">
      <div class="page-head">
        <h2>Presets &amp; engine</h2>
        <span class="spacer" />
        <button class="ghost" @click="addMode">+ Preset</button>
      </div>

      <!-- ENGINE — collapsed by default -->
      <details class="card">
        <summary>
          <span class="summary-label">Engine</span>
          <span class="summary-meta">
            {{ settings.api.model.replace('claude-', '') }} · solve {{ settings.api.solveEffort }} /
            verify {{ settings.api.checkEffort }}
          </span>
        </summary>
        <div class="config-body">
          <div class="field-row">
            <div class="field">
              <label>Model</label>
              <select v-model="settings.api.model" @change="onModelChange">
                <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select>
            </div>
            <div class="field">
              <label>Solve effort</label>
              <select v-model="settings.api.solveEffort">
                <option v-for="e in EFFORTS" :key="e" :value="e">{{ e }}</option>
              </select>
            </div>
            <div class="field">
              <label>Verify effort</label>
              <select v-model="settings.api.checkEffort">
                <option v-for="e in EFFORTS" :key="e" :value="e">{{ e }}</option>
              </select>
            </div>
            <div class="field">
              <label>Max tokens</label>
              <input v-model.number="settings.api.maxTokens" type="number" min="256" step="256" />
            </div>
          </div>

          <div class="field-row" style="margin-top: 0.7rem">
            <div class="field">
              <label>Image long edge (px)</label>
              <input v-model.number="settings.export.maxEdgePx" type="number" min="256" step="64" />
            </div>
            <div class="field">
              <label>JPEG quality — {{ settings.export.jpegQuality }}</label>
              <input
                v-model.number="settings.export.jpegQuality"
                type="range"
                min="0.4"
                max="1"
                step="0.05"
              />
            </div>
            <div class="field">
              <label>Crop padding (px)</label>
              <input v-model.number="settings.export.paddingPx" type="number" min="0" step="4" />
            </div>
          </div>

          <div class="field-row" style="margin-top: 0.7rem">
            <div class="field">
              <label>Input $ / 1M tok</label>
              <input v-model.number="settings.api.priceInputPerMTok" type="number" min="0" step="0.5" />
            </div>
            <div class="field">
              <label>Output $ / 1M tok</label>
              <input v-model.number="settings.api.priceOutputPerMTok" type="number" min="0" step="0.5" />
            </div>
            <div class="field" style="justify-content: flex-end">
              <button class="ghost" @click="resetSettings">Reset engine</button>
            </div>
          </div>
        </div>
      </details>

      <!-- PRESETS — each collapsed; expand to edit -->
      <details v-for="mode in modes" :key="mode.id" class="card">
        <summary>
          <span class="summary-label">{{ mode.label }}</span>
          <span class="summary-meta">
            {{ mode.feedbackStyle }} · {{ (mode.debounceMs / 1000).toFixed(mode.debounceMs % 1000 ? 1 : 0) }}s{{
              mode.cacheSolution ? ' · cache' : ''
            }}
          </span>
        </summary>
        <div class="config-body">
          <div class="field-row">
            <div class="field">
              <label>Label</label>
              <input v-model="mode.label" type="text" />
            </div>
            <div class="field">
              <label>Feedback style</label>
              <select v-model="mode.feedbackStyle">
                <option v-for="s in STYLES" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <div class="field">
              <label>Debounce (ms)</label>
              <input v-model.number="mode.debounceMs" type="number" min="300" step="100" />
            </div>
          </div>

          <div class="row" style="margin-top: 0.6rem; flex-wrap: wrap; gap: 1rem">
            <label class="toggle">
              <input v-model="mode.errorChecking" type="checkbox" />
              Grade errors
            </label>
            <label class="toggle">
              <input v-model="mode.cacheSolution" type="checkbox" />
              Cache solution (solve once, then verify)
            </label>
          </div>

          <div class="field" style="margin-top: 0.7rem">
            <label>System prompt</label>
            <textarea v-model="mode.systemPrompt" rows="5" />
          </div>

          <div class="row" style="margin-top: 0.6rem">
            <span class="muted mono" style="font-size: 0.68rem">{{ mode.id }}</span>
            <span class="spacer" />
            <button class="ghost danger" :disabled="modes.length <= 1" @click="removeMode(mode.id)">
              Delete
            </button>
          </div>
        </div>
      </details>

      <div class="row" style="margin-top: 0.7rem">
        <span class="spacer" />
        <button class="ghost" @click="resetModes">Reset presets to defaults</button>
      </div>
    </div>
  </section>
</template>
