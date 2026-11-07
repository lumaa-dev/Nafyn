<template>
  <button :type="type" class="icon-btn" :class="{ 'modal-close': toolbar, danger }" :aria-label="label" :title="label">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path v-if="symbol === 'close'" d="M6 6l12 12M18 6L6 18" />
      <path v-else-if="symbol === 'check'" d="M5 12.5l4.5 4.5L19 7.5" />
      <path v-else-if="symbol === 'plus'" d="M12 5v14M5 12h14" />
      <path v-else-if="symbol === 'trash'" d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12M10 11v5M14 11v5" />
      <path v-else-if="symbol === 'move'" d="M4 12h14M13 6l6 6-6 6" />
    </svg>
  </button>
</template>

<script lang="ts" setup>
// DESIGN.md "Icon-only buttons": a symbol and nothing else, a circle (1:1) whose symbol takes at least 90% of the
// button's width. The label is the accessible name and the tooltip (there is no text to explain it). `toolbar` is
// the one button type of a sheet's toolbar (`.modal-close`, Modal.vue); `danger` only changes its colour.
withDefaults(defineProps<{
  symbol: "close" | "check" | "plus" | "trash" | "move";
  label: string;
  toolbar?: boolean;
  danger?: boolean;
  type?: "button" | "submit";
}>(), { type: "button", toolbar: false, danger: false });
</script>

<style>
.icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 44px;
  height: 44px;
  aspect-ratio: 1 / 1;
  padding: 0;
  border-radius: 50%;
  border: 1px solid #ffffffae;
  background: transparent;
  color: #ffffffae;
  transition: background 0.2s ease-out, color 0.2s ease-out, border-color 0.2s ease-out, transform 0.15s ease-out;
}

.icon-btn svg {
  width: 70%;
  height: 70%;
  flex-shrink: 0;
}

.icon-btn:hover:not(:disabled) {
  background: #ffffffae;
  color: #000000;
}

.icon-btn:active:not(:disabled) {
  transform: scale(0.94);
}

.icon-btn.danger {
  border-color: var(--danger-text);
  color: var(--danger-text);
}

/* hollow and destructive: the hover is a faint wash, the button does not become a filled one */
.icon-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--danger-text) 20%, transparent);
  border-color: var(--danger-text);
  color: var(--danger-text);
}

@media (prefers-reduced-motion: reduce) {
  .icon-btn {
    transition: none;
  }
}
</style>
