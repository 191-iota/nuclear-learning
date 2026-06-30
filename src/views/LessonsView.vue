<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  lessonStore,
  dueLessons,
  lessonStats,
  reviewLesson,
  removeLesson,
  clearLessons,
  type Lesson,
} from '@/stores/lessons';
import MathText from '@/components/MathText.vue';

const stats = computed(() => lessonStats());
const all = computed(() => [...lessonStore.lessons].sort((a, b) => b.ts - a.ts));

// Review session, active recall over the due cards: show the problem, you try to
// recall the slip, then reveal and grade. Spaced repetition schedules the rest.
const queue = ref<Lesson[]>([]);
const idx = ref(0);
const revealed = ref(false);
const reviewing = ref(false);
const current = computed<Lesson | undefined>(() => queue.value[idx.value]);

function startReview() {
  queue.value = dueLessons();
  idx.value = 0;
  revealed.value = false;
  reviewing.value = queue.value.length > 0;
}

function grade(remembered: boolean) {
  const c = current.value;
  if (!c) return;
  reviewLesson(c.id, remembered);
  if (!remembered) queue.value.push(c); // come back to it before the session ends
  idx.value += 1;
  revealed.value = false;
  if (idx.value >= queue.value.length) reviewing.value = false;
}

function exitReview() {
  reviewing.value = false;
}

function rel(ms: number): string {
  const d = Date.now() - ms;
  const m = Math.round(d / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function dueIn(ms: number): string {
  const d = ms - Date.now();
  if (d <= 0) return 'due now';
  const h = Math.round(d / 3_600_000);
  if (h < 24) return `in ${Math.max(1, h)}h`;
  return `in ${Math.round(h / 24)}d`;
}

function statusLabel(l: Lesson): string {
  if (l.box >= 4) return 'mastered';
  if (l.reps === 0) return 'new';
  return dueIn(l.due);
}
</script>

<template>
  <section class="scroll">
    <div class="page-head">
      <h2>Lessons</h2>
      <span class="muted mono" style="font-size: 0.72rem">your own corrected mistakes</span>
      <span class="spacer" />
      <button v-if="all.length" class="ghost danger" @click="clearLessons">Clear all</button>
    </div>

    <!-- REVIEW, one card at a time, recall before reveal -->
    <template v-if="reviewing && current">
      <div class="review-head">
        <span class="muted mono">card {{ idx + 1 }} / {{ queue.length }}</span>
        <span class="spacer" />
        <button class="ghost" @click="exitReview">Done</button>
      </div>

      <div class="card flash">
        <div class="flash-tag">
          <span class="mono">{{ current.modeLabel }}</span>
          <span v-if="current.seen > 1" class="repeat mono">missed {{ current.seen }}×</span>
        </div>

        <div class="cue">
          <div v-if="current.problem" class="problem mono"><MathText :text="current.problem" /></div>
          <div class="ask">Recall the mistake you fixed here.</div>
          <div class="hint muted">Bring the mistake and the fix to mind before you reveal it.</div>
        </div>

        <button v-if="!revealed" class="primary reveal" @click="revealed = true">Reveal</button>

        <template v-else>
          <div class="answer">
            <template v-if="current.wrong || current.right">
              <div class="answer-k mono">what went wrong</div>
              <div class="mistake"><MathText :text="current.wrong || current.mistake" /></div>
              <template v-if="current.right">
                <div class="answer-k mono fix-k">the correction</div>
                <div class="fix"><MathText :text="current.right" /></div>
              </template>
            </template>
            <template v-else>
              <div class="answer-k mono">the mistake</div>
              <div class="mistake">{{ current.mistake }}</div>
            </template>
            <details v-if="current.solution" class="sol">
              <summary>worked solution</summary>
              <div class="sol-body mono"><MathText :text="current.solution" /></div>
            </details>
          </div>
          <div class="grade">
            <button class="ghost" @click="grade(false)">Again</button>
            <button class="primary" @click="grade(true)">Got it</button>
          </div>
        </template>
      </div>
    </template>

    <!-- DASHBOARD -->
    <template v-else-if="all.length">
      <div class="stat-grid">
        <div class="card stat">
          <div class="k">Due now</div>
          <div class="v">{{ stats.due }}</div>
          <div class="sub">ready to review</div>
        </div>
        <div class="card stat">
          <div class="k">Learning</div>
          <div class="v">{{ stats.learning }}</div>
          <div class="sub">still settling in</div>
        </div>
        <div class="card stat">
          <div class="k">Mastered</div>
          <div class="v">{{ stats.mastered }}</div>
          <div class="sub">recalled, well spaced</div>
        </div>
        <div class="card stat">
          <div class="k">Total</div>
          <div class="v">{{ stats.total }}</div>
          <div class="sub">mistakes logged</div>
        </div>
      </div>

      <div class="card cta">
        <div>
          <strong style="font-size: 0.9rem">{{ stats.due ? `${stats.due} due for review` : 'Nothing due right now' }}</strong>
          <div class="muted" style="font-size: 0.75rem; margin-top: 0.2rem">
            Each card shows the problem first, so you recall the fix before you see it. Cards come
            back for review as they fall due.
          </div>
        </div>
        <span class="spacer" />
        <button class="primary" :disabled="!stats.due" @click="startReview">Review →</button>
      </div>

      <div class="list">
        <div v-for="l in all" :key="l.id" class="card lesson">
          <div class="lesson-main">
            <div class="lesson-mistake"><MathText :text="l.wrong || l.mistake" /></div>
            <div class="lesson-meta muted mono">
              <span>{{ l.modeLabel }}</span>
              <template v-if="l.problem"><span class="dot">·</span><span>{{ l.problem }}</span></template>
              <span class="dot">·</span><span>{{ rel(l.ts) }}</span>
            </div>
          </div>
          <span class="badge mono" :class="{ mastered: l.box >= 4, due: l.due <= Date.now() }">
            {{ statusLabel(l) }}
          </span>
          <button class="x" title="Remove" @click="removeLesson(l.id)">×</button>
        </div>
      </div>
    </template>

    <!-- EMPTY -->
    <div v-else class="empty">
      No lessons yet. When the grader catches a mistake and you fix it, it is logged here. You
      review it later with spaced repetition so it stops coming back.
    </div>
  </section>
</template>

<style scoped>
.review-head {
  display: flex;
  align-items: center;
  margin-bottom: 0.8rem;
}

.flash {
  max-width: 640px;
  margin: 0 auto;
  padding: 1.4rem;
}

.flash-tag {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
}

.flash-tag .mono {
  font-size: 0.72rem;
  color: var(--muted);
}

.repeat {
  color: var(--gold);
  border: 1px solid var(--gold);
  border-radius: 999px;
  padding: 0.05rem 0.45rem;
  font-size: 0.66rem;
}

.cue {
  text-align: center;
  padding: 1.2rem 0;
}

.problem {
  font-size: 1.05rem;
  color: var(--ink);
  margin-bottom: 0.9rem;
  white-space: pre-wrap;
}

.ask {
  font-size: 1.1rem;
  font-weight: 600;
}

.hint {
  font-size: 0.78rem;
  margin-top: 0.4rem;
}

.reveal {
  display: block;
  width: 100%;
}

.answer {
  border-top: 1px solid var(--border);
  margin-top: 0.4rem;
  padding-top: 1rem;
}

.answer-k {
  font-size: 0.66rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--muted);
}

.mistake {
  font-size: 1.05rem;
  font-weight: 600;
  color: var(--ink);
  margin-top: 0.3rem;
}

.fix-k {
  margin-top: 0.9rem;
}

.fix {
  font-size: 1.05rem;
  color: var(--ink);
  margin-top: 0.3rem;
  border-left: 2px solid var(--good);
  padding-left: 0.6rem;
}

.sol {
  margin-top: 0.9rem;
}

.sol summary {
  cursor: pointer;
  font-size: 0.76rem;
  color: var(--muted);
}

.sol-body {
  font-size: 0.78rem;
  color: var(--ink);
  background: var(--panel-2);
  border-radius: var(--radius);
  padding: 0.7rem;
  margin-top: 0.5rem;
}

.grade {
  display: flex;
  gap: 0.6rem;
  margin-top: 1.2rem;
}

.grade button {
  flex: 1;
}

.cta {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.lesson {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.7rem 0.9rem;
}

.lesson-main {
  min-width: 0;
  flex: 1;
}

.lesson-mistake {
  font-size: 0.86rem;
  color: var(--ink);
}

.lesson-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  font-size: 0.68rem;
  margin-top: 0.2rem;
}

.lesson-meta .dot {
  opacity: 0.5;
}

.badge {
  flex: none;
  font-size: 0.66rem;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.1rem 0.5rem;
}

.badge.due {
  color: var(--gold);
  border-color: var(--gold);
}

.badge.mastered {
  color: var(--good);
  border-color: var(--good);
}

.x {
  flex: none;
  border: none;
  background: transparent;
  color: var(--muted);
  font-size: 1.1rem;
  line-height: 1;
  padding: 0.1rem 0.3rem;
  cursor: pointer;
}

.x:hover {
  color: var(--bad);
}
</style>
