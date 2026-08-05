<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import MainView from '@/views/MainView.vue';
import NotesView from '@/views/NotesView.vue';
import ChatView from '@/views/ChatView.vue';
import LessonsView from '@/views/LessonsView.vue';
import ArchiveView from '@/views/ArchiveView.vue';
import ProgressView from '@/views/ProgressView.vue';
import UsageView from '@/views/UsageView.vue';
import PresetsView from '@/views/PresetsView.vue';
import { theme, toggleTheme } from '@/stores/theme';
import { lessonStats } from '@/stores/lessons';
import { practiceText } from '@/stores/archive';

// Two apps in one shell, switched at the top level: MATH is the pad and everything
// built around it (grading, lessons, archive, drills); NOTES is the general study
// half (the notebook and the chat, the primary study tool). Each mode keeps its own
// tab row and remembers its place; Usage and Presets are app-wide and appear in both.

type AppMode = 'math' | 'notes';
type MathTab = 'pad' | 'lessons' | 'archive' | 'progress' | 'usage' | 'presets';
type NotesTab = 'notebook' | 'chat' | 'usage' | 'presets';

const UI_KEY = 'nl.ui.v1';

function loadUi(): { mode: AppMode; mathTab: MathTab; notesTab: NotesTab } {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as Partial<{
      mode: AppMode;
      mathTab: MathTab;
      notesTab: NotesTab;
    }>;
    return {
      mode: saved.mode === 'notes' ? 'notes' : 'math',
      mathTab: saved.mathTab ?? 'pad',
      notesTab: saved.notesTab ?? 'notebook',
    };
  } catch {
    return { mode: 'math', mathTab: 'pad', notesTab: 'notebook' };
  }
}

const ui = loadUi();
const mode = ref<AppMode>(ui.mode);
const mathTab = ref<MathTab>(ui.mathTab);
const notesTab = ref<NotesTab>(ui.notesTab);

watch([mode, mathTab, notesTab], () => {
  try {
    localStorage.setItem(
      UI_KEY,
      JSON.stringify({ mode: mode.value, mathTab: mathTab.value, notesTab: notesTab.value }),
    );
  } catch {
    /* non-fatal */
  }
});

const MATH_TABS: { id: MathTab; label: string }[] = [
  { id: 'pad', label: 'Pad' },
  { id: 'lessons', label: 'Lessons' },
  { id: 'archive', label: 'Archive' },
  { id: 'progress', label: 'Progress' },
  { id: 'usage', label: 'Usage' },
  { id: 'presets', label: 'Presets' },
];
const NOTES_TABS: { id: NotesTab; label: string }[] = [
  { id: 'notebook', label: 'Notebook' },
  { id: 'chat', label: 'Chat' },
  { id: 'usage', label: 'Usage' },
  { id: 'presets', label: 'Presets' },
];

const tabs = computed(() => (mode.value === 'math' ? MATH_TABS : NOTES_TABS));
const activeTab = computed(() => (mode.value === 'math' ? mathTab.value : notesTab.value));

function selectTab(id: string): void {
  if (mode.value === 'math') mathTab.value = id as MathTab;
  else notesTab.value = id as NotesTab;
}

// "Practice again" from the Archive and drills sent over from Progress land on the
// pad: MainView pins the text, this side brings the pad into view as one gesture.
watch(practiceText, (t) => {
  if (t) {
    mode.value = 'math';
    mathTab.value = 'pad';
  }
});

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
        <span class="brand-wordmark">nuclear<span class="brand-dim">·math</span></span>
      </span>
      <nav class="modeswitch" aria-label="Mode">
        <button
          class="mode-btn"
          :class="{ active: mode === 'math' }"
          :aria-current="mode === 'math' ? 'page' : undefined"
          @click="mode = 'math'"
        >
          Math
        </button>
        <button
          class="mode-btn"
          :class="{ active: mode === 'notes' }"
          :aria-current="mode === 'notes' ? 'page' : undefined"
          @click="mode = 'notes'"
        >
          Notes
        </button>
      </nav>
      <nav class="tabs" aria-label="Primary">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="tab"
          :class="{ active: activeTab === t.id }"
          :aria-current="activeTab === t.id ? 'page' : undefined"
          @click="selectTab(t.id)"
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
        :aria-label="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
        @click="toggleTheme"
      >
        {{ theme === 'dark' ? '☀' : '☾' }}
      </button>
    </header>

    <main class="content">
      <!-- Kept mounted so the pen stays connected and the canvas persists. -->
      <MainView v-show="mode === 'math' && mathTab === 'pad'" />
      <LessonsView v-if="mode === 'math' && mathTab === 'lessons'" />
      <ArchiveView v-if="mode === 'math' && mathTab === 'archive'" />
      <ProgressView v-if="mode === 'math' && mathTab === 'progress'" />
      <NotesView v-if="mode === 'notes' && notesTab === 'notebook'" />
      <ChatView v-if="mode === 'notes' && notesTab === 'chat'" />
      <UsageView v-if="activeTab === 'usage'" />
      <PresetsView v-if="activeTab === 'presets'" />
    </main>
  </div>
</template>
