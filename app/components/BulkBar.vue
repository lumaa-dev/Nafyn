<template>
  <div class="bulkbar" :class="{ lifted: !!currentTrack }">
    <div class="bulk-inner" role="toolbar" :aria-label="$t('bulk.select')">
      <template v-if="selecting">
        <span class="bulk-count over-chip" aria-live="polite">{{ $t('bulk.count', { count }) }}</span>
        <button type="button" class="over" @click="emit('select-all')">{{ allSelected ? $t('bulk.none') : $t('bulk.all') }}</button>
        <button type="button" class="over" :disabled="count === 0" @click="emit('actions', $event)">{{ $t('bulk.actions') }}</button>
        <button type="button" class="over" aria-pressed="true" @click="emit('stop')">{{ $t('bulk.done') }}</button>
      </template>
      <button v-else type="button" class="over" aria-pressed="false" :disabled="total === 0" @click="emit('start')">{{ $t('bulk.select') }}</button>
    </div>
  </div>
</template>

<script lang="ts" setup>
// The "Select" over button at the bottom right corner of a list page, and what it turns into once select mode
// is on. It floats at the bottom right corner of the view while the list scrolls (above the player bar when
// one is showing); the page adds the `bulk-page` class to its root, which gives the scroll area extra bottom
// padding so the last rows are never hidden behind it.
const props = defineProps<{ selecting: boolean, count: number, total: number }>();
const emit = defineEmits<{
  start: [],
  stop: [],
  "select-all": [],
  actions: [event: MouseEvent]
}>();

const { currentTrack } = useUnity();
const allSelected = computed(() => props.total > 0 && props.count >= props.total);
</script>

<style>
/* room under the last row for the floating button (the player bar's own clearance is already in `.view`) */
.view.bulk-page {
  padding-bottom: calc(6em + 56px);
}

.bulkbar {
  position: fixed;
  right: 1.2em;
  bottom: 1.2em;
  z-index: 90;
  display: flex;
  justify-content: flex-end;
  max-width: calc(100vw - 2.4em);
  /* the strip itself never catches clicks meant for what is beneath it */
  pointer-events: none;
}

/* the player bar (fixed, bottom) is ~80px tall: ride above it */
.bulkbar.lifted {
  bottom: calc(80px + 1.2em);
}

.bulkbar .bulk-inner {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  pointer-events: auto;
  max-width: 100%;
}

.bulkbar .over-chip {
  background: rgba(58, 58, 54, 0.72);
  -webkit-backdrop-filter: blur(16px) saturate(140%);
  backdrop-filter: blur(16px) saturate(140%);
  border: 1px solid rgba(255, 255, 255, 0.28);
  border-radius: 250px;
  color: #ffffff;
  font-family: var(--font-discy);
  font-size: 0.7em;
  padding: 0.7em 1.2em;
  white-space: nowrap;
}

/* rows in select mode: a checkbox in front, the whole row toggles */
.selectable-row {
  cursor: pointer;
}

.selectable-row.selected {
  background: #ffffff14;
  box-shadow: inset 3px 0 0 #ffffff;
}

.select-box {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  accent-color: #ffffff;
  cursor: pointer;
}

@media screen and (max-width: 800px) {
  .view.bulk-page {
    padding-bottom: calc(6em + 56px);
  }
}
</style>
