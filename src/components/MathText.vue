<script setup lang="ts">
import { computed } from 'vue';
import { renderMath, renderRich } from '@/math';

// Renders prose mixed with LaTeX ($...$ / \(...\) inline, $$...$$ / \[...\] display,
// plus bare undelimited TeX fragments the model slipped in). The HTML is built by
// renderMath, which escapes everything outside the math. `rich` additionally renders
// full markdown (headings, lists, tables, code, quotes, links, emphasis) — the
// chat's answer format; its block styling lives here so every rich consumer
// matches.
const props = defineProps<{ text?: string; rich?: boolean }>();
const html = computed(() => (props.rich ? renderRich(props.text ?? '') : renderMath(props.text ?? '')));
</script>

<template>
  <span class="mathtext" :class="{ rich }" v-html="html" />
</template>

<style scoped>
.mathtext {
  white-space: pre-wrap;
  word-break: break-word;
}

/* Rich output is block-structured (paragraph divs, lists, tables); the wrapper
   must be a block itself so those lay out, while plain MathText stays inline. */
.mathtext.rich {
  display: block;
}

.mathtext.rich :deep(.md-p) {
  margin: 0.35em 0;
}

.mathtext.rich :deep(.md-p:first-child),
.mathtext.rich :deep(.md-h:first-child) {
  margin-top: 0;
}

.mathtext.rich :deep(.md-h) {
  font-weight: 650;
  margin: 0.75em 0 0.25em;
  line-height: 1.35;
}

.mathtext.rich :deep(.md-h1) {
  font-size: 1.16em;
}

.mathtext.rich :deep(.md-h2) {
  font-size: 1.09em;
}

.mathtext.rich :deep(.md-h3),
.mathtext.rich :deep(.md-h4) {
  font-size: 1.03em;
}

.mathtext.rich :deep(.md-l) {
  margin: 0.35em 0;
  padding-left: 1.5em;
}

.mathtext.rich :deep(.md-l .md-sub) {
  margin: 0.15em 0;
}

.mathtext.rich :deep(li) {
  margin: 0.15em 0;
}

.mathtext.rich :deep(.md-c) {
  font-family: var(--mono);
  font-size: 0.88em;
  background: color-mix(in srgb, var(--border) 40%, transparent);
  border-radius: 0.25em;
  padding: 0.05em 0.3em;
}

.mathtext.rich :deep(.md-code) {
  font-family: var(--mono);
  font-size: 0.84em;
  line-height: 1.55;
  background: color-mix(in srgb, var(--border) 32%, transparent);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 0.55em 0.75em;
  margin: 0.45em 0;
  overflow-x: auto;
  white-space: pre;
}

.mathtext.rich :deep(.md-q) {
  margin: 0.45em 0;
  padding: 0.1em 0 0.1em 0.75em;
  border-left: 3px solid var(--border);
  color: var(--muted);
}

.mathtext.rich :deep(.md-hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 0.8em 0;
}

/* Tables scroll inside their own wrapper instead of stretching the thread. */
.mathtext.rich :deep(.md-tw) {
  margin: 0.45em 0;
  overflow-x: auto;
}

.mathtext.rich :deep(.md-t) {
  border-collapse: collapse;
  font-size: 0.95em;
}

.mathtext.rich :deep(.md-t th),
.mathtext.rich :deep(.md-t td) {
  border: 1px solid var(--border);
  padding: 0.3em 0.6em;
  text-align: left;
  vertical-align: top;
}

.mathtext.rich :deep(.md-t th) {
  font-weight: 650;
  background: color-mix(in srgb, var(--border) 25%, transparent);
}

.mathtext.rich :deep(.md-a) {
  color: inherit;
  text-decoration: underline;
  text-underline-offset: 2px;
}

/* Inline math is plain inline content, so it sits on the prose baseline like any
   word. The old inline-block-with-own-scrollbox treatment middle-aligned every
   formula off the baseline and broke $$ centering; a formula too wide for its card
   now scrolls at the card body instead (the panels own the overflow). */
.mathtext :deep(.katex) {
  font-size: 1.04em;
}

.mathtext :deep(.katex-display::-webkit-scrollbar) {
  height: 4px;
}

.mathtext :deep(.katex-display::-webkit-scrollbar-track) {
  background: transparent;
}

.mathtext :deep(.katex-display::-webkit-scrollbar-thumb) {
  background: var(--border);
  border-radius: 999px;
}

/* Display math keeps KaTeX's own centered block; long formulas scroll in it. */
.mathtext :deep(.katex-display) {
  margin: 0.4rem 0;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  scrollbar-color: var(--border) transparent;
}

/* A formula neither KaTeX nor the repair pass could parse: legible source instead
   of red error soup. */
.mathtext :deep(.tex-fallback) {
  font-family: var(--mono);
  font-size: 0.86em;
  color: var(--muted);
  background: color-mix(in srgb, var(--border) 40%, transparent);
  border-radius: 0.25em;
  padding: 0.05em 0.3em;
}
</style>
