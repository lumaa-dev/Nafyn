<template>
  <div class="seek">
    <span class="time">{{ formatDuration(state.currentTime) }}</span>
    <input type="range" min="0" :max="state.duration || 0" step="1" :value="state.currentTime" :aria-label="$t('player.seek')" @input="seek(($event.target as HTMLInputElement).valueAsNumber)" />
    <span class="time">{{ formatDuration(state.duration) }}</span>
  </div>
</template>

<script lang="ts" setup>
// The only part of the player that changes four times a second. It reads `state.currentTime` itself, so a tick
// re-renders these three elements and not the whole bar around them (queue list, covers, buttons).
const { state, seek } = useUnity();

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
</script>

<style scoped>
.seek {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.seek input[type="range"] {
  flex: 1;
  min-width: 0;
}

.seek .time {
  color: color-mix(in srgb, var(--np-text, #ffffff) 90%, transparent);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-discy);
  font-size: 0.7em;
  width: 2.5em;
}
</style>
