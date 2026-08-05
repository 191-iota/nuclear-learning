<script setup lang="ts">
import { modes, addMode, removeMode, resetModes } from '@/stores/modes';
import { settings, resetSettings } from '@/stores/settings';
import { MODELS, EFFORTS } from '@/models';

const STYLES = ['spoken', 'chime', 'both'];

function resetEngine(): void {
  if (confirm('Reset all engine settings to their defaults?')) resetSettings();
}

function deleteMode(id: string, label: string): void {
  if (confirm(`Delete the "${label}" preset? This cannot be undone.`)) removeMode(id);
}

function resetPresetList(): void {
  if (confirm('Reset all presets to their defaults? Custom presets will be deleted.')) resetModes();
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
              <label>Max tokens</label>
              <input v-model.number="settings.api.maxTokens" type="number" min="256" step="256" />
            </div>
          </div>

          <div class="eng-row">
            <div class="field span-2">
              <label>Chat model (Notes mode)</label>
              <select v-model="settings.api.chatModel">
                <option v-for="m in MODELS" :key="m.id" :value="m.id">{{ m.label }}</option>
              </select>
            </div>
            <div class="field span-2">
              <label>Chat effort</label>
              <select v-model="settings.api.chatEffort">
                <option v-for="e in EFFORTS" :key="e" :value="e">{{ e }}</option>
              </select>
            </div>
            <div class="field span-2">
              <label>Page grid (0 = off)</label>
              <input v-model.number="settings.tablet.gridSize" type="number" min="0" max="100" step="5" />
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
              <label>Auto-clear after finish (s, 0 = off)</label>
              <input v-model.number="settings.scan.autoClearSec" type="number" min="0" step="1" />
            </div>
            <div class="field span-2">
              <label>Input source</label>
              <select v-model="settings.input.source">
                <option value="tablet">Tablet</option>
                <option value="neo">Neo pen</option>
              </select>
            </div>
            <div class="field span-2">
              <label>Tablet aspect ratio</label>
              <select v-model.number="settings.tablet.aspect">
                <option :value="1.6">16:10 (most Wacom)</option>
                <option :value="1.7778">16:9</option>
                <option :value="1.5">3:2</option>
                <option :value="1.3333">4:3</option>
              </select>
            </div>
          </div>

          <div class="eng-row">
            <div class="field span-2">
              <label>Pen width ({{ settings.tablet.baseWidth }})</label>
              <input v-model.number="settings.tablet.baseWidth" type="range" min="0.5" max="4" step="0.1" />
            </div>
            <div class="field span-2">
              <label>Stroke smoothing ({{ Math.round(settings.tablet.smoothing * 100) }}%)</label>
              <input v-model.number="settings.tablet.smoothing" type="range" min="0" max="0.7" step="0.05" />
            </div>
          </div>

          <div class="row" style="margin-top: 0.8rem; flex-wrap: wrap; gap: 0.6rem 1rem">
            <label class="toggle">
              <input v-model="settings.ui.autoExpandFeedback" type="checkbox" />
              Open hints &amp; answers in a large window
            </label>
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
              The solve model reads the problem once ("Problem written") and also writes the hints;
              the cheap model grades each Check press; the confirm model judges the Finish. Prices
              come from the model, so the Usage cost is exact per request.
            </span>
            <span class="spacer" />
            <button class="ghost" @click="resetEngine">Reset engine</button>
          </div>
        </div>
      </details>

      <!-- PRESETS, each collapsed; expand to edit -->
      <details v-for="mode in modes" :key="mode.id" class="card">
        <summary>
          <span class="summary-label">{{ mode.label }}</span>
          <span class="summary-meta">
            {{ mode.feedbackStyle }}
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
          </div>

          <div class="field" style="margin-top: 0.7rem">
            <label>System prompt</label>
            <textarea v-model="mode.systemPrompt" rows="5" />
          </div>

          <div class="row" style="margin-top: 0.6rem">
            <span class="muted mono" style="font-size: 0.68rem">{{ mode.id }}</span>
            <span class="spacer" />
            <button
              class="ghost danger"
              :disabled="modes.length <= 1"
              @click="deleteMode(mode.id, mode.label)"
            >
              Delete
            </button>
          </div>
        </div>
      </details>

      <div class="row" style="margin-top: 0.7rem">
        <span class="spacer" />
        <button class="ghost" @click="resetPresetList">Reset presets to defaults</button>
      </div>
    </div>
  </section>
</template>
