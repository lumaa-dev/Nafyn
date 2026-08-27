<template>
  <div class="stat-tile">
    <span class="label">{{ label }}</span>
    <span class="value">{{ value }}</span>
    <span v-if="delta !== undefined && delta !== null" class="delta" :class="{ up: delta > 0, down: delta < 0 }">
      {{ delta > 0 ? '+' : '' }}{{ delta }}%
    </span>
    <ChartsSparkline v-if="spark && spark.length > 1" :values="spark" />
  </div>
</template>

<script lang="ts" setup>
// One headline number. `delta` is a percentage change against the comparison period, which is why it is
// nullable rather than defaulting to 0 - "no previous period to compare against" and "exactly the same as
// last time" are different facts and must not render identically.
defineProps<{
  label: string,
  value: string,
  delta?: number | null,
  spark?: number[]
}>();
</script>

<style>
.stat-tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px;
  border-radius: 12px;
  background: #00000030;
  min-width: 0;
}

.stat-tile .label {
  font-size: 0.65em;
  color: #666666;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.stat-tile .value {
  font-family: "Discy";
  font-size: 1.4em;
  line-height: 1.1;
}

.stat-tile .delta {
  font-family: "Discy";
  font-size: 0.65em;
  color: #666666;
}

.stat-tile .delta.up { color: #93c47d; }
.stat-tile .delta.down { color: #e06666; }
</style>
