<script setup lang="ts">
import { computed, ref } from 'vue';
import MathText from '@/components/MathText.vue';
import {
  archiveStore,
  indexAufgabe,
  loadImage,
  practiceText,
  removeAufgabe,
  searchArchive,
  topicCounts,
  type ArchivedAufgabe,
} from '@/stores/archive';

// The archive tab: every stored Aufgabe, found by typing what you remember of it.
// Search runs synchronously over the in-memory index (title / topics / keywords /
// description / statement, weighted in that order); the topic chips narrow first.

const query = ref('');
const topic = ref('');
const results = computed(() => searchArchive(query.value, topic.value || undefined));
const topics = computed(() => topicCounts().slice(0, 12));
const filtering = computed(() => query.value.trim() !== '' || topic.value !== '');

const open = ref<ArchivedAufgabe | null>(null);
const openImage = ref('');
const reindexing = ref(false);

async function openItem(it: ArchivedAufgabe): Promise<void> {
  open.value = it;
  openImage.value = '';
  // The full-size image lives in its own IndexedDB store and loads on demand;
  // the list renders from thumbnails alone.
  openImage.value = await loadImage(it.id);
}

function close(): void {
  open.value = null;
  openImage.value = '';
}

// "Practice again": the statement lands pinned on the pad, ready to copy and re-solve.
function practice(it: ArchivedAufgabe): void {
  practiceText.value = it.statement || it.problem || it.title;
  close();
}

function onDelete(it: ArchivedAufgabe): void {
  if (!confirm(`Delete "${it.title || it.problem || 'this entry'}" from the archive?`)) return;
  void removeAufgabe(it.id);
  close();
}

async function onReindex(it: ArchivedAufgabe): Promise<void> {
  if (reindexing.value) return;
  reindexing.value = true;
  try {
    await indexAufgabe(it.id);
  } finally {
    reindexing.value = false;
  }
}

function toggleTopic(t: string): void {
  topic.value = topic.value === t ? '' : t;
}

function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString('de-CH', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
</script>

<template>
  <section class="scroll">
    <div class="config-wrap">
      <div class="page-head">
        <h2>Archive</h2>
        <span class="count">
          {{ archiveStore.items.length }} Aufgaben<template v-if="filtering"> · {{ results.length }} found</template>
        </span>
        <span class="spacer" />
      </div>

      <input
        v-model="query"
        class="search"
        type="search"
        placeholder="Search: topic, method, keyword… (potenzgesetze, bruchgleichung, induktion)"
        aria-label="Search the archive"
      />

      <div v-if="topics.length" class="chiprow">
        <button
          v-for="t in topics"
          :key="t.topic"
          class="chip"
          :class="{ active: topic === t.topic }"
          @click="toggleTopic(t.topic)"
        >
          {{ t.topic }} <span class="chip-n">{{ t.count }}</span>
        </button>
      </div>

      <div v-if="archiveStore.items.length === 0" class="empty">
        Nothing archived yet. A page stores itself the moment the finish check says
        CORRECT; the Archive button on the pad stores any page by hand. Labels and
        search terms are written by a background call right after saving.
      </div>
      <div v-else-if="results.length === 0" class="empty">
        No match. Try a coarser word ("bruch", "potenz"), or clear the topic chip.
      </div>

      <div class="agrid">
        <button v-for="it in results" :key="it.id" class="acard" @click="openItem(it)">
          <img v-if="it.thumb" :src="it.thumb" alt="" class="athumb" />
          <span class="acard-body">
            <span class="atitle">{{ it.title || it.problem || 'Unlabeled page' }}</span>
            <span v-if="it.description" class="adesc"><MathText :text="it.description" /></span>
            <span class="ameta">
              <span class="dot" :class="it.verdict" :title="it.verdict === 'correct' ? 'Solved' : 'Open'" />
              {{ fmtDate(it.ts) }} · {{ it.modeLabel }}
              <template v-if="it.difficulty"> · L{{ it.difficulty }}</template>
              <span v-if="!it.indexed" class="unidx"> · not indexed yet</span>
            </span>
            <span v-if="it.topics.length" class="atags">
              <span v-for="t in it.topics" :key="t" class="tag">{{ t }}</span>
            </span>
          </span>
        </button>
      </div>
    </div>

    <!-- Detail: the archived page at full size, with everything known about it. -->
    <div v-if="open" class="ovl" @click.self="close">
      <div class="ovl-card" role="dialog" aria-modal="true" :aria-label="open.title || open.problem">
        <div class="ovl-head">
          <span>{{ open.title || open.problem || 'Aufgabe' }}</span>
          <button class="x" aria-label="Close" title="Close" @click="close">×</button>
        </div>
        <div class="ameta detailmeta">
          <span class="dot" :class="open.verdict" />
          {{ open.verdict === 'correct' ? 'Solved' : 'Open' }} · {{ fmtDate(open.ts) }} ·
          {{ open.modeLabel }}<template v-if="open.difficulty"> · difficulty {{ open.difficulty }}/7</template>
        </div>
        <div v-if="open.topics.length" class="atags detailtags">
          <span v-for="t in open.topics" :key="t" class="tag">{{ t }}</span>
        </div>
        <div v-if="open.description" class="ovl-desc"><MathText :text="open.description" /></div>
        <div v-if="open.statement" class="ovl-stmt"><MathText :text="open.statement" /></div>
        <img v-if="openImage" :src="openImage" class="ovl-img" alt="Archived handwritten page" />
        <details v-if="open.solution" class="ovl-sol">
          <summary>Reference solution</summary>
          <div class="ovl-solbody"><MathText :text="open.solution" /></div>
        </details>
        <div class="ovl-actions">
          <button title="Pin this statement on the pad and solve it again" @click="practice(open)">
            Practice again
          </button>
          <button
            v-if="!open.indexed"
            :disabled="reindexing"
            title="Write the search label for this entry now"
            @click="onReindex(open)"
          >
            {{ reindexing ? 'Indexing…' : 'Index now' }}
          </button>
          <span class="spacer" />
          <button class="ghost danger" @click="onDelete(open)">Delete</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.count {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--muted);
  margin-left: 0.8rem;
}

.search {
  width: 100%;
  font-size: 0.95rem;
  padding: 0.55rem 0.7rem;
  margin-bottom: 0.6rem;
}

.chiprow {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-bottom: 0.9rem;
}

.chip {
  font-size: 0.72rem;
  padding: 0.25rem 0.6rem;
  border-radius: 999px;
}

.chip.active {
  border-color: var(--gold);
  color: var(--gold);
}

.chip-n {
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

.empty {
  color: var(--muted);
  font-size: 0.85rem;
  line-height: 1.6;
  padding: 1.2rem 0.2rem;
  max-width: 44rem;
}

.agrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(270px, 1fr));
  gap: 0.7rem;
}

.acard {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  text-align: left;
  padding: 0;
  overflow: hidden;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
}

.acard:hover {
  border-color: var(--muted);
}

.athumb {
  width: 100%;
  height: 120px;
  object-fit: contain;
  object-position: left top;
  background: #fff;
  border-bottom: 1px solid var(--border);
  padding: 0.4rem;
}

.acard-body {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.55rem 0.7rem 0.65rem;
}

.atitle {
  font-size: 0.88rem;
  font-weight: 600;
  color: var(--ink);
  line-height: 1.35;
}

.adesc {
  font-size: 0.78rem;
  color: var(--muted);
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.ameta {
  font-family: var(--mono);
  font-size: 0.68rem;
  color: var(--muted);
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.dot {
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  background: var(--muted);
  flex: none;
}

.dot.correct {
  background: var(--good);
}

.unidx {
  color: var(--gold);
}

.atags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.1rem;
}

.tag {
  font-size: 0.66rem;
  font-family: var(--mono);
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0.08rem 0.45rem;
}

/* Detail overlay */
.ovl {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.35);
  padding: 1.2rem;
}

.ovl-card {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: 0 14px 48px rgba(0, 0, 0, 0.25);
  width: min(860px, 94vw);
  max-height: 86vh;
  overflow-y: auto;
  padding: 1rem 1.3rem 1.2rem;
}

.ovl-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.8rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--ink);
  margin-bottom: 0.35rem;
}

.ovl-head .x {
  border: 0;
  background: none;
  color: var(--muted);
  font-size: 1.1rem;
  cursor: pointer;
  padding: 0.1rem 0.3rem;
}

.ovl-head .x:hover {
  color: var(--ink);
}

.detailmeta {
  margin-bottom: 0.4rem;
}

.detailtags {
  margin-bottom: 0.6rem;
}

.ovl-desc {
  font-size: 0.88rem;
  color: var(--muted);
  line-height: 1.55;
  margin-bottom: 0.7rem;
}

.ovl-stmt {
  font-size: 0.95rem;
  line-height: 1.6;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.6rem 0.8rem;
  margin-bottom: 0.8rem;
  overflow-x: auto;
}

.ovl-img {
  display: block;
  max-width: 100%;
  background: #fff;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  margin-bottom: 0.8rem;
}

.ovl-sol {
  margin-bottom: 0.9rem;
}

.ovl-sol summary {
  font-family: var(--mono);
  font-size: 0.75rem;
  color: var(--muted);
  cursor: pointer;
}

.ovl-solbody {
  font-size: 0.88rem;
  line-height: 1.6;
  padding: 0.5rem 0.2rem 0;
  overflow-x: auto;
}

.ovl-actions {
  display: flex;
  align-items: center;
  gap: 0.6rem;
}
</style>
