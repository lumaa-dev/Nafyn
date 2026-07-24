<template>
  <ol class="queue-panel">
    <li v-if="state.queue.length === 0" class="empty">{{ $t('player.queueEmpty') }}</li>
    <span>
      <button :filled="state.repeat !== 'off' ? '' : 'hollow'" @click="cycleRepeat()">
        <p>{{ repeatTitle }}</p>
      </button>
      <button filled="hollow" disabled>
        <p>{{ $t('player.shuffle') }}</p>
      </button>
    </span>
    <li v-for="(track, index) in state.queue" :key="track.id" :class="{ active: index === state.currentIndex }" @click="playFromQueue(index)">
      <img :src="track.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" draggable="false" loading="lazy" />
      <span class="col">
        <span class="title">{{ track.title }}</span>
        <span class="artist">{{ track.artistName }}</span>
      </span>
      <button filled="hollow" class="round" @click.stop="removeFromQueue(index)">&times;</button>
    </li>
  </ol>
</template>

<script lang="ts" setup>
import noCover from '../../assets/no-cover.png';

const { t } = useI18n();
const { state, playFromQueue, removeFromQueue, cycleRepeat } = usePlayer();

const repeatTitle = computed(() => {
  switch (state.value.repeat) {
    case "queue": return t("player.repeat");
    case "track": return t("player.repeatOne");
    default: return t("player.repeatOff");
  }
});
</script>

<style scoped>
.queue-panel {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow-y: auto;
}

.queue-panel > span {
  display: flex;
  flex-direction: row;
  gap: 10px;
  width: 100%;
  margin: 10px 0;
}

.queue-panel > span button {
  width: 100%;
}

.queue-panel li {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
}

.queue-panel li:hover {
  background: #ffffff10;
}

.queue-panel li.active {
  background: #ffffff20;
}

.queue-panel li img {
  width: 45px;
  height: 45px;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  background: #00000040;
  flex-shrink: 0;
}

.queue-panel .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.queue-panel .title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-panel .artist {
  font-size: 0.85em;
  color: #666666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-panel .round {
  width: 2em;
  height: 2em;
  border-radius: 50%;
  padding: 0 !important;
  font-size: 1em;
  line-height: 1;
  flex-shrink: 0;
}

.queue-panel .empty {
  color: #666666;
  cursor: default;
  justify-content: center;
}

@media screen and (max-width: 800px) {
  .queue-panel > span button {
    font-size: 0.7em;
  }
}
</style>
