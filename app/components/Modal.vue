<template>
  <Teleport to="body">
    <div v-if="modelValue" class="modal-backdrop" @click.self="close">
      <div class="modal">
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
  display: flex;
  flex-direction: column;
  gap: 14px;
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
