<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';

/**
 * A destructive action that asks once, in place.
 *
 * The app used window.confirm for every delete, which hands the decision to a grey
 * OS box with the page's own name at the top of it. This keeps the question where
 * the action is: the first click arms the button and changes its label, the second
 * carries it out. Moving focus away, or a few seconds of silence, disarms it, so
 * the armed state can never be left lying around to be hit by accident.
 */
const props = withDefaults(
  defineProps<{
    label: string;
    /** What the armed button says. Keep it short; it replaces the label in place. */
    confirmLabel?: string;
    title?: string;
    disabled?: boolean;
    ghost?: boolean;
  }>(),
  { confirmLabel: 'Click again', title: '', disabled: false, ghost: false },
);

const emit = defineEmits<{ confirm: [] }>();

const armed = ref(false);
let timer: number | undefined;

function disarm(): void {
  armed.value = false;
  if (timer) window.clearTimeout(timer);
  timer = undefined;
}

function onClick(): void {
  if (props.disabled) return;
  if (armed.value) {
    disarm();
    emit('confirm');
    return;
  }
  armed.value = true;
  timer = window.setTimeout(disarm, 4000);
}

onBeforeUnmount(disarm);
</script>

<template>
  <button
    type="button"
    class="confirm-btn danger"
    :class="{ ghost, armed }"
    :disabled="disabled"
    :title="armed ? 'Click again to confirm, or move away to cancel' : title"
    @click.stop="onClick"
    @blur="disarm"
    @keydown.esc.stop="disarm"
  >
    {{ armed ? confirmLabel : label }}
  </button>
</template>

<style scoped>
.confirm-btn.armed {
  color: var(--accent-ink);
  background: var(--bad);
  border-color: var(--bad);
}
</style>
