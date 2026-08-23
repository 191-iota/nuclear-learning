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

// Two apps in one shell, switched at the top level: PROBLEM SOLVING is the pad and
// everything built around it (grading, lessons, archive, drills), shipped tuned for
// math; STUDY is the general half, the notebook and the chat that has read it.
//
// Three levels of navigation used to sit in one strip of identical buttons: the two
// apps, the pages of whichever one was open, and Usage and Presets which belong to
// neither and were repeated in both. With every one of them drawn as the same pill
// there was no way to see which question a click was answering, and the word "Notes"
// appeared twice, once as an app and once as a page inside it.
//
// So each level now looks like what it is. The app is a filled switch; its pages are
// underlined tabs; Usage and Presets sit apart on the right, where they read as
// belonging to the whole thing, and pressing the one you are already on hands you back
// the page you came from.
//
// The internal id of the solving half stays 'math': it is what `nl.ui.v1` already
// holds on disk and what config/modes.json calls the shipped grader preset. Only
// the label moved, so the pipeline and its math tuning are untouched. 'notes' stays
// the id of the other half for the same reason.

type AppMode = 'math' | 'notes';
type MathTab = 'pad' | 'lessons' | 'archive' | 'progress';
type NotesTab = 'notebook' | 'chat';
type AppPanel = '' | 'usage' | 'presets';

const UI_KEY = 'nl.ui.v1';

const MATH_TABS: { id: MathTab; label: string }[] = [
  { id: 'pad', label: 'Pad' },
  { id: 'lessons', label: 'Lessons' },
  { id: 'archive', label: 'Archive' },
  { id: 'progress', label: 'Progress' },
];
const NOTES_TABS: { id: NotesTab; label: string }[] = [
  { id: 'notebook', label: 'Notebook' },
  { id: 'chat', label: 'Chat' },
];
const PANELS: { id: Exclude<AppPanel, ''>; label: string }[] = [
  { id: 'usage', label: 'Usage' },
  { id: 'presets', label: 'Presets' },
];

function loadUi(): { mode: AppMode; mathTab: MathTab; notesTab: NotesTab; panel: AppPanel } {
  try {
    const saved = JSON.parse(localStorage.getItem(UI_KEY) ?? '{}') as Partial<{
      mode: AppMode;
      mathTab: string;
      notesTab: string;
      panel: AppPanel;
    }>;
    // Usage and Presets used to be stored as tabs of a mode. A saved copy from then
    // reopens on the panel it named, with a real page waiting underneath it.
    const stale = saved.mathTab === 'usage' || saved.mathTab === 'presets' ? saved.mathTab : '';
    const staleNotes = saved.notesTab === 'usage' || saved.notesTab === 'presets' ? saved.notesTab : '';
    return {
      mode: saved.mode === 'notes' ? 'notes' : 'math',
      mathTab: (MATH_TABS.some((t) => t.id === saved.mathTab) ? saved.mathTab : 'pad') as MathTab,
      notesTab: (NOTES_TABS.some((t) => t.id === saved.notesTab)
        ? saved.notesTab
        : 'notebook') as NotesTab,
      // || rather than ??, because "not a panel" is the empty string here and ?? would
      // stop at it and drop the one that follows.
      panel: (saved.panel || stale || staleNotes || '') as AppPanel,
    };
  } catch {
    return { mode: 'math', mathTab: 'pad', notesTab: 'notebook', panel: '' };
  }
}

const ui = loadUi();
const mode = ref<AppMode>(ui.mode);
const mathTab = ref<MathTab>(ui.mathTab);
const notesTab = ref<NotesTab>(ui.notesTab);
const panel = ref<AppPanel>(ui.panel);

watch([mode, mathTab, notesTab, panel], () => {
  try {
    localStorage.setItem(
      UI_KEY,
      JSON.stringify({
        mode: mode.value,
        mathTab: mathTab.value,
        notesTab: notesTab.value,
        panel: panel.value,
      }),
    );
  } catch {
    /* non-fatal */
  }
});

const tabs = computed(() => (mode.value === 'math' ? MATH_TABS : NOTES_TABS));
const activeTab = computed(() => (mode.value === 'math' ? mathTab.value : notesTab.value));

function selectMode(m: AppMode): void {
  mode.value = m;
  panel.value = ''; // switching app shows that app, never the settings you last opened
}

function selectTab(id: string): void {
  panel.value = '';
  if (mode.value === 'math') mathTab.value = id as MathTab;
  else notesTab.value = id as NotesTab;
}

/** Pressing the panel you are already on is the way back to the page underneath. */
function togglePanel(id: Exclude<AppPanel, ''>): void {
  panel.value = panel.value === id ? '' : id;
}

// "Practice again" from the Archive and drills sent over from Progress land on the
// pad: MainView pins the text, this side brings the pad into view as one gesture.
watch(practiceText, (t) => {
  if (t) {
    mode.value = 'math';
    mathTab.value = 'pad';
    panel.value = '';
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
        <span class="brand-wordmark">nuclear<span class="brand-dim">·learning</span></span>
      </span>
      <nav class="modeswitch" aria-label="App">
        <button
          class="mode-btn"
          :class="{ active: mode === 'math' }"
          :aria-current="mode === 'math' ? 'true' : undefined"
          title="The pad and the pipeline around it: solve, check, hint, finish, then review cards and weak spots. Tuned for math."
          @click="selectMode('math')"
        >
          Problem Solving
        </button>
        <button
          class="mode-btn"
          :class="{ active: mode === 'notes' }"
          :aria-current="mode === 'notes' ? 'true' : undefined"
          title="The notebook you write in, and a chat that has read what is in it. Any subject."
          @click="selectMode('notes')"
        >
          Study
        </button>
      </nav>
      <nav class="tabs" aria-label="Pages">
        <button
          v-for="t in tabs"
          :key="t.id"
          class="tab"
          :class="{ active: !panel && activeTab === t.id }"
          :aria-current="!panel && activeTab === t.id ? 'page' : undefined"
          @click="selectTab(t.id)"
        >
          {{ t.label }}<span v-if="t.id === 'lessons' && dueCount > 0" class="tab-badge">{{
            dueCount
          }}</span>
        </button>
      </nav>
      <span class="spacer" />
      <!-- Neither app's: the whole thing's. Pressing the one you are on goes back. -->
      <nav class="apptabs" aria-label="Settings">
        <button
          v-for="p in PANELS"
          :key="p.id"
          class="tab apptab"
          :class="{ active: panel === p.id }"
          :aria-current="panel === p.id ? 'page' : undefined"
          :title="
            panel === p.id
              ? 'Back to what you were doing'
              : p.id === 'usage'
                ? 'What the requests have cost'
                : 'Engine settings and grading presets'
          "
          @click="togglePanel(p.id)"
        >
          {{ p.label }}
        </button>
      </nav>
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
      <MainView v-show="!panel && mode === 'math' && mathTab === 'pad'" />
      <LessonsView v-if="!panel && mode === 'math' && mathTab === 'lessons'" />
      <ArchiveView v-if="!panel && mode === 'math' && mathTab === 'archive'" />
      <ProgressView v-if="!panel && mode === 'math' && mathTab === 'progress'" />
      <NotesView v-if="!panel && mode === 'notes' && notesTab === 'notebook'" />
      <ChatView v-if="!panel && mode === 'notes' && notesTab === 'chat'" />
      <UsageView v-if="panel === 'usage'" />
      <PresetsView v-if="panel === 'presets'" />
    </main>
  </div>
</template>
