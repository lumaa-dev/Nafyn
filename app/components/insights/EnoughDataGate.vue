<template>
  <div v-if="!gate || gate.enough">
    <slot />
  </div>
  <div v-else class="gate">
    <h3>{{ $t('insights.gate.title') }}</h3>
    <p>{{ $t('insights.gate.body', { tracks: gate.needUniqueTracks, minutes: gate.needMinutes }) }}</p>
    <div class="progress">
      <div class="bar"><div class="fill" :style="{ width: `${pct(gate.uniqueTracks, gate.needUniqueTracks)}%` }" /></div>
      <span>{{ $t('insights.gate.tracksProgress', { have: gate.uniqueTracks, need: gate.needUniqueTracks }) }}</span>
    </div>
    <div class="progress">
      <div class="bar"><div class="fill" :style="{ width: `${pct(gate.minutes, gate.needMinutes)}%` }" /></div>
      <span>{{ $t('insights.gate.minutesProgress', { have: gate.minutes, need: gate.needMinutes }) }}</span>
    </div>
  </div>
</template>

<script lang="ts" setup>
// The "enough data" gate. A top-10 built from four plays is not a ranking, it is noise wearing a ranking's
// clothes - so every ranking surface is wrapped in this, and shows progress toward the threshold instead.
//
// The two bars are an either/or, not an and: clearing one threshold is enough (the server checks the same
// way), which is why a user who listens to one album on repeat all month still gets their insights.
export interface Gate {
  enough: boolean,
  uniqueTracks: number,
  minutes: number,
  needUniqueTracks: number,
  needMinutes: number
}

defineProps<{ gate: Gate | null }>();

function pct(have: number, need: number): number {
  if (need <= 0) return 100;
  return Math.min(100, Math.round((have / need) * 100));
}
</script>

<style>
.gate {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 24px;
  border-radius: 12px;
  background: #00000030;
}

.gate h3 {
  font-size: 1em;
}

.gate p {
  font-size: 0.8em;
  color: #999999;
}

.gate .progress {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.7em;
  color: #666666;
}

.gate .bar {
  height: 6px;
  border-radius: 3px;
  background: #ffffff14;
  overflow: hidden;
}

.gate .fill {
  height: 100%;
  border-radius: 3px;
  background: #e18c46;
  transition: width 0.4s ease;
}
</style>
