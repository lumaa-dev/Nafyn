<template>
  <div class="donutchart">
    <div class="ring" :style="{ background: gradient }">
      <div class="hole">
        <span class="total">{{ centerValue }}</span>
        <span class="caption">{{ centerLabel }}</span>
      </div>
    </div>

    <ul class="legend">
      <li v-for="(slice, i) in withOther" :key="slice.label">
        <span class="swatch" :style="{ background: color(i) }" />
        <span class="name">{{ slice.label }}</span>
        <span class="pct">{{ percent(slice.value) }}%</span>
      </li>
    </ul>
  </div>
</template>

<script lang="ts" setup>
// Share-of-listening donut, drawn with a conic-gradient rather than SVG arcs - the same technique the
// storage panel in settings.vue already uses, so the two read as the same product.
export interface DonutSlice {
  label: string,
  value: number
}

const props = defineProps<{ slices: DonutSlice[], centerValue: string, centerLabel: string, maxSlices?: number }>();

const PALETTE = ["#e18c46", "#44cf44", "#4499cf", "#cf4444", "#cf44b8", "#cfc444", "#8c44cf", "#44cfa8"];

function color(i: number): string {
  return PALETTE[i % PALETTE.length];
}

// beyond a handful of slices a donut stops being readable, so the tail is folded into one "other" wedge
// instead of being drawn as a dozen invisible slivers
const withOther = computed<DonutSlice[]>(() => {
  const limit = props.maxSlices ?? 6;
  const sorted = [...props.slices].sort((a, b) => b.value - a.value);
  if (sorted.length <= limit) return sorted;

  const head = sorted.slice(0, limit);
  const tail = sorted.slice(limit).reduce((sum, s) => sum + s.value, 0);
  return tail > 0 ? [...head, { label: $t('insights.charts.other'), value: tail }] : head;
});

const total = computed(() => withOther.value.reduce((sum, s) => sum + s.value, 0));

function percent(value: number): number {
  if (total.value <= 0) return 0;
  return Math.round((value / total.value) * 100);
}

const gradient = computed(() => {
  if (total.value <= 0) return "#ffffff14";

  let cumulative = 0;
  const stops = withOther.value.map((slice, i) => {
    const start = (cumulative / total.value) * 100;
    cumulative += slice.value;
    const end = (cumulative / total.value) * 100;
    return `${color(i)} ${start}% ${end}%`;
  });

  return `conic-gradient(${stops.join(", ")})`;
});
</script>

<style>
.donutchart {
  display: flex;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
}

.donutchart .ring {
  width: 160px;
  height: 160px;
  border-radius: 50%;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.donutchart .hole {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  background: #2a2a27;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
}

.donutchart .total {
  font-family: "Discy";
  font-size: 1.1em;
}

.donutchart .caption {
  font-size: 0.6em;
  color: #666666;
  text-align: center;
}

.donutchart .legend {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  padding: 0;
  font-size: 0.75em;
  flex: 1;
  min-width: 0;
}

.donutchart .legend li {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.donutchart .swatch {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  flex-shrink: 0;
}

.donutchart .name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.donutchart .pct {
  font-family: "Discy";
  font-size: 0.9em;
  color: #666666;
  flex-shrink: 0;
}
</style>
