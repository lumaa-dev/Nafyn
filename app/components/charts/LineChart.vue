<template>
  <div class="linechart">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="ariaLabel">
      <line
        v-for="(y, i) in gridLines"
        :key="`g${i}`"
        :x1="PAD_X" :x2="W - PAD_X" :y1="y" :y2="y"
        stroke="#ffffff14" stroke-width="1"
      />
      <polyline
        v-for="serie in series"
        :key="serie.name"
        :points="pointsOf(serie.points)"
        fill="none"
        :stroke="serie.color"
        :stroke-width="serie.muted ? 1.5 : 2.5"
        :stroke-dasharray="serie.muted ? '4 4' : undefined"
        stroke-linejoin="round"
        stroke-linecap="round"
        vector-effect="non-scaling-stroke"
      />
    </svg>

    <ul class="x-labels">
      <li v-for="(label, i) in labels" :key="i">{{ label }}</li>
    </ul>

    <ul class="legend">
      <li v-for="serie in series" :key="serie.name">
        <span class="swatch" :style="{ background: serie.color }" />
        {{ serie.name }}
      </li>
    </ul>
  </div>
</template>

<script lang="ts" setup>
// Overlaid line series - "this week vs last week", "minutes per month across years".
//
// Hand-rolled SVG with a fixed viewBox and no measurement at setup time, so it renders identically during
// SSR and hydration. `preserveAspectRatio="none"` lets it stretch to whatever width it is given;
// `vector-effect="non-scaling-stroke"` is what stops that stretch from also stretching the line weight.
export interface Series {
  name: string,
  color: string,
  points: number[],
  /** drawn thinner and dashed - used for the comparison/previous series */
  muted?: boolean
}

const props = defineProps<{ series: Series[], labels: string[], ariaLabel?: string }>();

const W = 600;
const H = 180;
const PAD_X = 8;
const PAD_Y = 12;

const GRID_ROWS = 4;
const gridLines = computed(() =>
  Array.from({ length: GRID_ROWS + 1 }, (_, i) => PAD_Y + (i * (H - PAD_Y * 2)) / GRID_ROWS)
);

// One scale shared by every series, so the comparison line is actually comparable. Scaling each series to
// its own maximum would make a quiet week look identical to a busy one.
const max = computed(() => {
  const highest = Math.max(...props.series.flatMap((s) => s.points), 0);
  // never zero, or every point would divide by it and collapse onto the baseline
  return highest > 0 ? highest : 1;
});

function pointsOf(values: number[]): string {
  if (values.length === 0) return "";
  // a single point has no span to divide by; pin it to the left edge rather than dividing by zero
  const step = values.length > 1 ? (W - PAD_X * 2) / (values.length - 1) : 0;

  return values
    .map((value, i) => {
      const x = PAD_X + i * step;
      const y = H - PAD_Y - (value / max.value) * (H - PAD_Y * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
</script>

<style>
.linechart {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.linechart svg {
  width: 100%;
  height: 180px;
  display: block;
}

.linechart .x-labels {
  display: flex;
  justify-content: space-between;
  list-style: none;
  padding: 0 8px;
  font-family: "Discy";
  font-size: 0.6em;
  color: #666666;
}

.linechart .legend {
  display: flex;
  gap: 16px;
  list-style: none;
  padding: 0;
  font-size: 0.7em;
  color: #ffffffae;
}

.linechart .legend li {
  display: flex;
  align-items: center;
  gap: 6px;
}

.linechart .swatch {
  width: 10px;
  height: 3px;
  border-radius: 2px;
  flex-shrink: 0;
}
</style>
