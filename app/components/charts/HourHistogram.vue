<template>
  <div class="hourchart">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" role="img" :aria-label="ariaLabel">
      <rect
        v-for="point in points"
        :key="point.hour"
        :x="point.hour * slot + GAP / 2"
        :y="H - heightOf(point)"
        :width="slot - GAP"
        :height="heightOf(point)"
        rx="2"
        :fill="point.hour === peakHour ? '#e18c46' : '#ffffff33'"
      />
    </svg>

    <ul class="x-labels">
      <li v-for="hour in [0, 6, 12, 18, 23]" :key="hour">{{ String(hour).padStart(2, '0') }}</li>
    </ul>
  </div>
</template>

<script lang="ts" setup>
// Hour-of-day histogram: 24 fixed columns, always, so the x-axis reads as a clock rather than as "whichever
// hours happened to have data". The busiest hour is highlighted, since "when do I listen" is the question
// this chart exists to answer.
export interface HourPoint {
  hour: number,
  plays: number,
  minutes: number
}

const props = defineProps<{ points: HourPoint[], metric?: "plays" | "minutes", ariaLabel?: string }>();

const W = 480;
const H = 120;
const GAP = 3;
const slot = W / 24;

const metric = computed(() => props.metric ?? "plays");
const max = computed(() => Math.max(...props.points.map((p) => p[metric.value]), 0));

const peakHour = computed(() => {
  if (max.value <= 0) return -1;
  return props.points.find((p) => p[metric.value] === max.value)?.hour ?? -1;
});

function heightOf(point: HourPoint): number {
  if (max.value <= 0) return 0;
  return (point[metric.value] / max.value) * H;
}
</script>

<style>
.hourchart {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.hourchart svg {
  width: 100%;
  height: 120px;
  display: block;
}

.hourchart .x-labels {
  display: flex;
  justify-content: space-between;
  list-style: none;
  padding: 0;
  font-family: "Discy";
  font-size: 0.6em;
  color: #666666;
}
</style>
