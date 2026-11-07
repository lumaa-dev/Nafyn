<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-backdrop" @click.self="close">
      <div ref="modalEl" class="modal" :class="`modal-${size}`" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown.tab="trapFocus">
        <!-- DESIGN.md "Modals / Sheets": every sheet has a Close button in its toolbar, on the top leading edge -->
        <div class="modal-toolbar">
          <span class="modal-toolbar-start"><IconButton toolbar symbol="close" :label="$t('common.close')" @click="close" /></span>
          <h2 class="modal-title">{{ title }}</h2>
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

/* leading | title | trailing: the two outer columns share the space equally, so the title stays centred whatever
   the toolbar holds (one button on the right, none, several) */
.modal-toolbar {
  position: relative;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
  padding: 16px 0 12px;
}

.modal-toolbar-start,
.modal-toolbar-end {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.modal-toolbar-end {
  justify-content: flex-end;
}

/* the one button type of a toolbar (every sheet): an icon-only circle. Only the colour differs, to show the action
   type (`danger` is red). */
.icon-btn.modal-close {
  border: 1px solid transparent;
  background: #ffffff20;
  color: #ffffffae;
}

.icon-btn.modal-close:hover:not(:disabled) {
  background: #ffffffae;
  color: #000000;
}

.icon-btn.modal-close.danger {
  background: var(--danger-fill);
  color: #ffffff;
}

.icon-btn.modal-close.danger:hover:not(:disabled) {
  background: var(--danger-fill-hover);
  color: #ffffff;
}

.modal-title {
  font-size: 1em;
  margin: 0;
  max-width: 100%;
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
