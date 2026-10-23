<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-backdrop" @click.self="close">
      <div ref="modalEl" class="modal" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1" @keydown.tab="trapFocus">
        <!-- <div class="modal-grip" /> -->
        <h2 v-if="title" class="modal-title">{{ title }}</h2>
        <div class="modal-body">
          <slot />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script lang="ts" setup>
const props = defineProps<{ modelValue: boolean; title?: string }>();
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
  background: #00000080;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal {
  background: #1a1a1a;
  border-radius: 16px;
  padding: 24px;
  width: 320px;
  max-height: 70vh;
  overflow-y: auto;
  overflow-x: hidden;
  overscroll-behavior: contain;
  /* a modal scrolls, it doesn't show a scrollbar (the page behind it keeps its own) */
  scrollbar-width: none;
  -ms-overflow-style: none;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.modal::-webkit-scrollbar,
.modal-body::-webkit-scrollbar {
  display: none;
}

.modal:focus {
  outline: none;
}

.modal-grip {
  display: none;
}

.modal-title {
  font-size: 1em;
  margin: 0;
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

@media screen and (max-width: 800px) {
  .modal-backdrop {
    align-items: flex-end;
  }

  .modal {
    width: 100%;
    max-height: 85vh;
    border-radius: 20px 20px 0 0;
    padding: 24px 20px;
    overflow-y: hidden;
    animation: modal-sheet-up 0.25s ease-out;
  }

  .modal-grip {
    display: block;
    width: 40px;
    height: 4px;
    border-radius: 2px;
    background: #ffffff40;
    margin: 0 auto 8px;
    flex-shrink: 0;
  }

  .modal-body {
    overflow-y: auto;
    min-height: 0;
    scrollbar-width: none;
    -ms-overflow-style: none;
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
