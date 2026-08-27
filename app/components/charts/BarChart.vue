<template>
  <ul class="barchart">
    <li v-for="(item, i) in items" :key="item.key ?? i">
      <span class="rank">{{ i + 1 }}</span>
      <span class="col">
        <span class="label" :title="item.label">{{ item.label }}</span>
        <span v-if="item.sublabel" class="sublabel">{{ item.sublabel }}</span>
        <span class="track">
          <span class="fill" :style="{ width: `${widthOf(item.value)}%` }" />
        </span>
      </span>
      <span class="value">{{ item.display ?? item.value }}</span>
    </li>
  </ul>
</template>

<script lang="ts" setup>
// Horizontal ranked bars for "top tracks / artists / albums".
//
// Deliberately DOM + CSS rather than SVG: the bars are a list of labelled rows, and building them out of
// real list markup keeps the labels selectable, ellipsised by the browser and readable to a screen reader,
// none of which comes free inside an <svg>. The charts that actually plot a shape use SVG instead.
export interface BarItem {
  key?: string,
  label: string,
  sublabel?: string | null,
  value: number,
  /** pre-formatted value to show instead of the raw number */
  display?: string
}

const props = defineProps<{ items: BarItem[] }>();

// bars are scaled against the largest value present, so the top entry always fills the row and the rest are
// read relative to it - an absolute scale would leave every bar a sliver for a light listening month
const max = computed(() => Math.max(...props.items.map((i) => i.value), 0));

function widthOf(value: number): number {
  if (max.value <= 0) return 0;
  // a floor of 2% so an entry with real (but tiny) listening still shows something rather than nothing
  return Math.max(2, (value / max.value) * 100);
}
</script>

<style>
.barchart {
  display: flex;
  flex-direction: column;
  gap: 12px;
  list-style: none;
  padding: 0;
}

.barchart li {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.barchart .rank {
  font-family: "Discy";
  font-size: 0.7em;
  color: #666666;
  width: 22px;
  flex-shrink: 0;
  text-align: right;
}

.barchart .col {
  display: flex;
  flex-direction: column;
  gap: 4px;
  flex: 1;
  min-width: 0;
}

.barchart .label {
  font-size: 0.85em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.barchart .sublabel {
  font-size: 0.65em;
  color: #666666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.barchart .track {
  display: block;
  height: 6px;
  border-radius: 3px;
  background: #ffffff14;
  overflow: hidden;
}

.barchart .fill {
  display: block;
  height: 100%;
  border-radius: 3px;
  background: #e18c46;
  transition: width 0.4s ease;
}

.barchart .value {
  font-family: "Discy";
  font-size: 0.7em;
  color: #ffffffae;
  flex-shrink: 0;
  white-space: nowrap;
}
</style>
