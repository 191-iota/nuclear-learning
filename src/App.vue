<script setup lang="ts">
import { computed, ref } from 'vue';
import MainView from '@/views/MainView.vue';
import LessonsView from '@/views/LessonsView.vue';
import ProgressView from '@/views/ProgressView.vue';
import UsageView from '@/views/UsageView.vue';
import PresetsView from '@/views/PresetsView.vue';
import { theme, toggleTheme } from '@/stores/theme';
import { lessonStats } from '@/stores/lessons';

type View = 'pad' | 'lessons' | 'progress' | 'usage' | 'presets';
const view = ref<View>('pad');
const tabs: { id: View; label: string }[] = [
  { id: 'pad', label: 'Pad' },
  { id: 'lessons', label: 'Lessons' },
  { id: 'progress', label: 'Progress' },
  { id: 'usage', label: 'Usage' },
  { id: 'presets', label: 'Presets' },
];
const dueCount = computed(() => lessonStats().due);
</script>

<template>
  <div class="shell">
    <header class="topnav">
      <span class="brand">
        <svg class="brand-mark" viewBox="0 0 64 64" aria-hidden="true">
          <path d="M18.43 7.51A28 28 0 0 1 45.57 7.51L36.85 23.25A10 10 0 0 0 27.15 23.25Z" fill="currentColor" />
          <path d="M60.00 32.49A28 28 0 0 1 46.42 56.00L37.15 40.57A10 10 0 0 0 42.00 32.17Z" fill="currentColor" />
          <path d="M17.58 56.00A28 28 0 0 1 4.00 32.49L22.00 32.17A10 10 0 0 0 26.85 40.57Z" fill="currentColor" />
          <circle cx="32" cy="32" r="4.6" fill="var(--gold)" />
        </svg>
        nuclear<span class="brand-dim">·learning</span>
      </span>
      <nav class="tabs">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="tab"
          :class="{ active: view === t.id }"
          @click="view = t.id"
        >
          {{ t.label }}<span v-if="t.id === 'lessons' && dueCount > 0" class="tab-badge">{{
            dueCount
          }}</span>
        </button>
      </nav>
      <span class="spacer" />
      <button
        class="theme"
        :title="theme === 'dark' ? 'Switch to light' : 'Switch to dark'"
        @click="toggleTheme"
      >
        {{ theme === 'dark' ? '☾' : '☀' }}
      </button>
    </header>

    <main class="content">
      <!-- Kept mounted so the pen stays connected and the canvas persists. -->
      <MainView v-show="view === 'pad'" />
      <LessonsView v-if="view === 'lessons'" />
      <ProgressView v-if="view === 'progress'" />
      <UsageView v-if="view === 'usage'" />
      <PresetsView v-if="view === 'presets'" />
    </main>
  </div>
</template>
