<script setup lang="ts">
import { modes, addMode, removeMode, resetModes } from '@/stores/modes';
import { settings, resetSettings } from '@/stores/settings';
import { MODELS, EFFORTS } from '@/models';

const STYLES = ['spoken', 'chime', 'both'];
</script>

<template>
  <section class="scroll">
    <div class="config-wrap">
      <div class="page-head">
        <h2>Presets &amp; engine</h2>
        <span class="spacer" />
        <button class="ghost" @click="addMode">+ Preset</button>
      </div>

      <!-- ENGINE, collapsed by default -->
      <details class="card">
        <summary>
          <span class="summary-label">Engine</span>
          <span class="summary-meta">
            solve {{ settings.api.solveModel }} · verify {{ settings.api.verifyModel }}
          </span>
        </summary>
        <div class="config-body">
          <div class="eng-row">
            <div class="field span-2">
              <label>Solve model</label>
              <select v-model="settings.api.solveModel">
                <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select>
            </div>
            <div class="field span-2">
              <label>Verify model (cheap)</label>
              <select v-model="settings.api.verifyModel">
                <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select>
            </div>
            <div class="field span-2">
              <label>Confirm model</label>
              <select v-model="settings.api.confirmModel">
                <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select>
            </div>
          </div>

          <div class="eng-row">
            <div class="field span-2">
              <label>Verify effort</label>
              <select v-model="settings.api.verifyEffort">
                <option v-for="e in EFFORTS" :key="e" :value="e">{{ e }}</option>
              </select>
            </div>
            <div class="field span-2">
              <label>Feedback language</label>
              <select v-model="settings.api.feedbackLang">
                <option value="English">English</option>
                <option value="German">German</option>
              </select>
            </div>
            <div class="field span-2">
              <label>Max tokens</label>
              <input v-model.number="settings.api.maxTokens" type="number" min="256" step="256" />
            </div>
          </div>

          <div class="eng-row">
            <div class="field span-2">
              <label>Image long edge (px)</label>
              <input v-model.number="settings.export.maxEdgePx" type="number" min="256" step="64" />
            </div>
            <div class="field span-2">
              <label>JPEG quality ({{ settings.export.jpegQuality }})</label>
              <input
                v-model.number="settings.export.jpegQuality"
                type="range"
                min="0.4"
                max="1"
                step="0.05"
              />
            </div>
            <div class="field span-2">
              <label>Crop padding (px)</label>
              <input v-model.number="settings.export.paddingPx" type="number" min="0" step="4" />
            </div>
          </div>

          <div class="eng-row">
            <div class="field span-2">
              <label>Re-check after (strokes)</label>
              <input v-model.number="settings.scan.minNewStrokes" type="number" min="1" step="1" />
            </div>
            <div class="field span-2">
              <label>Idle flush (ms)</label>
              <input v-model.number="settings.scan.idleFlushMs" type="number" min="1000" step="500" />
            </div>
            <div class="field span-2">
              <label>Auto-clear (s, 0 = off)</label>
              <input v-model.number="settings.scan.autoClearSec" type="number" min="0" step="1" />
            </div>
          </div>

          <div class="row" style="margin-top: 0.8rem; flex-wrap: wrap; gap: 0.6rem 1rem">
            <label class="toggle">
              <input v-model="settings.api.trackSkills" type="checkbox" />
              Track skill mastery (Progress tab)
            </label>
            <span class="muted" style="font-size: 0.7rem; flex: 1; min-width: 14rem">
              Tags each solved math problem against a fixed skill map on the solve call that already
              runs, so it adds no request. Off stops the Progress tab from updating.
            </span>
          </div>

          <div class="row" style="margin-top: 0.8rem">
            <span class="muted" style="font-size: 0.72rem">
              The solve model works each problem out once and the confirm model signs off a finished
              answer; the cheap verify model checks every scan in between. Prices come from the
              model, so the Usage cost is exact per scan.
            </span>
            <span class="spacer" />
            <button class="ghost" @click="resetSettings">Reset engine</button>
          </div>
        </div>
      </details>

      <!-- PRESETS, each collapsed; expand to edit -->
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
