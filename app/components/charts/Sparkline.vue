<template>
  <svg class="sparkline" :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" aria-hidden="true">
    <polyline
      :points="path"
      fill="none"
      stroke="#e18c46"
      stroke-width="2"
      stroke-linejoin="round"
      stroke-linecap="round"
      vector-effect="non-scaling-stroke"
    />
  </svg>
</template>

<script lang="ts" setup>
// A bare trend line for stat tiles - no axes, no labels, no legend. Decorative by design: the number beside
// it is the fact, this is only the shape of how it got there.
const props = defineProps<{ values: number[] }>();

const W = 100;
const H = 24;

const path = computed(() => {
  const values = props.values;
  if (values.length === 0) return "";

  const max = Math.max(...values, 0) || 1;
  const step = values.length > 1 ? W / (values.length - 1) : 0;

  return values
    .map((value, i) => `${(i * step).toFixed(1)},${(H - (value / max) * H).toFixed(1)}`)
    .join(" ");
});
</script>

<style>
.sparkline {
  width: 100%;
  height: 24px;
  display: block;
}
</style>
