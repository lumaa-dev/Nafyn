<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-backdrop" @click.self="close">
      <div ref="modalEl" class="modal" :class="`modal-${size}`" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown.tab="trapFocus">
        <!-- DESIGN.md "Modals / Sheets": every sheet has a Close button in its toolbar, on the top leading edge -->
        <div class="modal-toolbar">
          <button type="button" class="modal-close" @click="close">{{ $t('common.close') }}</button>
          <h2 v-if="title" class="modal-title">{{ title }}</h2>
          <span class="modal-toolbar-end"><slot name="toolbar" /></span>
        </div>
        <div class="modal-body">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script lang="ts" setup>
// "compact": little information, a few paragraphs and a few actions. "large": a lot of it (forms, pickers, lists),
// the same size ratio as the viewport. Below 800px neither exists: a sheet is 95% of the viewport's height.
const props = withDefaults(defineProps<{ modelValue: boolean; title?: string; size?: "compact" | "large" }>(), { size: "compact" });
const emit = defineEmits<{ (e: "update:modelValue", value: boolean): void }>();

const modalEl = ref<HTMLElement | null>(null);
let returnFocusTo: HTMLElement | null = null;

const FOCUSABLE = 'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

// keyboard focus moves into the dialog when it opens, stays inside while it is open, and goes back to what
// opened it when it closes
watch(() => props.modelValue, async (open) => {
  if (open) {
    returnFocusTo = document.activeElement as HTMLElement | null;
    await nextTick();
    (modalEl.value?.querySelector<HTMLElement>(FOCUSABLE) ?? modalEl.value)?.focus();
  } else {
    returnFocusTo?.focus?.();
    returnFocusTo = null;
  }
});

function trapFocus(e: KeyboardEvent) {
  const items = [...(modalEl.value?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0]!;
  const last = items[items.length - 1]!;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function close() {
  emit("update:modelValue", false);
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape" && props.modelValue) close();
}

onMounted(() => document.addEventListener("keydown", onKeydown));
onUnmounted(() => document.removeEventListener("keydown", onKeydown));

defineExpose({ close });
</script>

<style>
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  /* the background darkens and can no longer be interacted with: the backdrop covers it and catches the clicks */
  background: #000000a6;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal {
  background: #1a1a1a;
  border-radius: 16px;
  /* the toolbar is part of the sheet, so the content is pushed below it instead of sitting under it */
  padding: 0 24px 24px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modal:focus {
  outline: none;
}

/* compact: vertically large, a few paragraphs and a few actions */
.modal-compact {
  width: min(480px, 92vw);
  max-height: 80vh;
}

/* large: the viewport's own size ratio, for text fields, sliders, pickers... */
.modal-large {
  width: 80vw;
  height: 80vh;
}

.modal-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-shrink: 0;
  padding: 16px 0 12px;
}

.modal-toolbar-end {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

/* toolbar actions: the same height as Close, a label never wraps */
.modal-toolbar-end button {
  font-size: 0.8em;
  padding-block: 0.6em;
}

.modal-close {
  flex-shrink: 0;
  font-size: 0.8em;
  padding: 0.6em 1.2em;
  border: 1px solid transparent;
  border-radius: 250px;
  background: #ffffff20;
  color: #ffffffae;
  transition: background 0.2s ease-out, color 0.2s ease-out;
}

.modal-close:hover {
  background: #ffffffae;
  color: #000000;
}

.modal-title {
  font-size: 1em;
  margin: 0;
  flex: 1 1 auto;
  min-width: 0;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  /* a modal scrolls, it doesn't show a scrollbar (the page behind it keeps its own) */
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.modal-body::-webkit-scrollbar {
  display: none;
}

@media screen and (max-width: 800px) {
  .modal-backdrop {
    align-items: flex-end;
  }

  /* 95% of the whole vertical viewport, toolbar at the top - no compact / large modes */
  .modal,
  .modal-compact,
  .modal-large {
    width: 100%;
    height: 95vh;
    max-height: 95vh;
    border-radius: 20px 20px 0 0;
    padding: 0 20px 24px;
    animation: modal-sheet-up 0.25s ease-out;
  }
}

@keyframes modal-sheet-up {
  from { transform: translateY(100%); }
  to { transform: translateY(0); }
}

@media (prefers-reduced-motion: reduce) {
  .modal {
    animation: none !important;
  }
}
</style>
