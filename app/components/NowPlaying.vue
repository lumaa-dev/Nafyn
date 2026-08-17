<template>
  <div class="now-playing" v-if="currentTrack">
    <div class="track" @click="navigateTo('/now-playing')">
      <img :src="currentTrack.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" draggable="false" loading="lazy" />
      <span class="col">
        <span class="title">{{ currentTrack.title }}</span>
        <span class="artist">{{ currentTrack.artistName }}</span>
      </span>
    </div>

    <div class="controls">
      <div class="buttons">
        <button filled="hollow" class="round" :disabled="!hasPrev && state.currentTime <= 3" @click="prev()"><img src="../assets/icons/prev.svg" draggable="false" /></button>
        <button filled class="round" @click="togglePlay()">
          <img v-if="state.isPlaying" src="../assets/icons/pause.svg" draggable="false" />
          <img v-else src="../assets/icons/play.svg" draggable="false" />
        </button>
        <button filled="hollow" class="round" :disabled="!hasNext" @click="next()"><img src="../assets/icons/next.svg" draggable="false" /></button>
      </div>

      <div class="seek big">
        <span class="time">{{ formatDuration(state.currentTime) }}</span>
        <input type="range" min="0" :max="state.duration || 0" step="1" :value="state.currentTime" @input="seek(($event.target as HTMLInputElement).valueAsNumber)" />
        <span class="time">{{ formatDuration(state.duration) }}</span>
      </div>
    </div>

    <div class="side big">
      <button filled="hollow" class="round" @click="toggleQueue()"><span class="queue-count">{{ state.queue.length }}</span></button>

      <button :filled="state.repeat != 'off' ? '' : 'hollow'" class="round" :title="repeatTitle" @click="cycleRepeat()">
        <img v-if="state.repeat === 'track'" src="../assets/icons/repeat-one.svg" draggable="false" />
        <img v-else src="../assets/icons/repeat.svg" draggable="false" />
      </button>

      <div class="volume">
        <button filled="hollow" class="round" @click="toggleMute()">
          <img v-if="state.muted || state.volume === 0" src="../assets/icons/volume-mute.svg" draggable="false" />
          <img v-else src="../assets/icons/volume.svg" draggable="false" />
        </button>
        <input type="range" min="0" max="1" step="0.01" :value="state.muted ? 0 : state.volume" @input="setVolume(($event.target as HTMLInputElement).valueAsNumber)" />
      </div>
    </div>

    <ol class="queue big" v-if="showQueue">
      <li v-if="state.queue.length === 0" class="empty">{{ $t('player.queueEmpty') }}</li>
      <li v-for="(track, index) in state.queue" :key="track.id" :class="{ active: index === state.currentIndex }" @click="playFromQueue(index)">
        <span class="row">
          <img :src="track.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" draggable="false" loading="lazy" />
          <span class="col">
            <span class="title">{{ track.title }}</span>
            <span class="artist">{{ track.artistName }}</span>
          </span>
        </span>
        <button filled="hollow" class="round" @click.stop="removeFromQueue(index)">&times;</button>
      </li>
    </ol>
  </div>
</template>

<script lang="ts" setup>
import noCover from '../assets/no-cover.png';

const { t } = useI18n();
const { state, currentTrack, hasNext, hasPrev, togglePlay, next, prev, seek, setVolume, toggleMute, removeFromQueue, playFromQueue, cycleRepeat } = usePlayer();

const showQueue = ref(false);
function toggleQueue() {
  showQueue.value = !showQueue.value;
}

const repeatTitle = computed(() => {
  switch (state.value.repeat) {
    case "queue":
      return t("player.repeat")

    case "track":
      return t("player.repeatOne")

    default:
      return t("player.repeatOff")
  }
});

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
</script>

<style scoped>
.small {
  display: none;
}

.big {
  display: initial;
}

.now-playing {
  position: fixed;
  bottom: 0;
  left: 0;
  width: 100%;
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 30px;
  padding: 15px 30px;
  background: #00000050;
  backdrop-filter: blur(20px);
  border-top: 1px solid #ffffff20;
  z-index: 200;
  font-size: 0.7em;
}

.now-playing .round {
  width: 2.4em;
  height: 2.4em;
  border-radius: 50%;
  padding: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.now-playing .round img {
  width: 1.1em;
  height: 1.1em;
  transition: filter 0.15s ease-out;
}

button[filled="hollow"].round img {
  filter: invert();
}

button[filled="hollow"].round:not(:disabled):hover img {
  filter: none;
}

.now-playing .track {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  width: 220px;
  flex-shrink: 0;
  cursor: pointer;
  overflow: hidden;
}

.now-playing .track img {
  width: 45px;
  height: 45px;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  background: #00000040;
  flex-shrink: 0;
}

.now-playing .col {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.now-playing .row {
  display: flex;
  flex-direction: row;
  overflow: hidden;
}

.now-playing .title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-playing .artist {
  font-size: 0.85em;
  color: #666666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-playing .controls {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  flex: 1;
  max-width: 600px;
}

.now-playing .buttons {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 15px;
}

.now-playing .seek {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.now-playing .seek input[type="range"] {
  flex: 1;
}

.now-playing .time {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-family: "Discy";
  width: 2.5em;
}

.now-playing .side {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 15px;
  flex-shrink: 0;
}

.now-playing .queue-count {
  font-size: 1em;
}

.now-playing .volume {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 8px;
}

.now-playing .volume input[type="range"] {
  width: 90px;
}

.now-playing input[type="range"] {
  appearance: none;
  height: 4px;
  border-radius: 250px;
  background: #ffffff30;
  outline: none;
}

.now-playing input[type="range"]::-webkit-slider-thumb {
  appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #ffffffae;
  cursor: pointer;
}

.now-playing .queue {
  position: absolute;
  bottom: 110%;
  right: 30px;
  width: 320px;
  max-height: 50vh;
  overflow-y: auto;
  list-style: none;
  padding: 10px;
  margin: 0;
  background: #000000ee;
  backdrop-filter: blur(20px);
  border: 1px solid #ffffff20;
  border-radius: 10px;
}

.now-playing .queue li {
  display: flex;
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px;
  border-radius: 6px;
  cursor: pointer;
}

.now-playing .queue li:hover {
  background: #ffffff10;
}

.now-playing .queue li.active {
  background: #ffffff20;
}

.now-playing .queue li .row {
  align-items: center;
  gap: 15px;
}

.now-playing .queue li img {
  width: 35px;
  height: 35px;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  background: #00000040;
}

.now-playing .queue li button {
  font-size: 1em;
  line-height: 1;
}

.now-playing .queue .empty {
  color: #666666;
  cursor: default;
  justify-content: center;
}

@media screen and (max-width: 800px) {
  .small {
    display: initial !important;
  }

  .big {
    display: none !important;
  }

  .now-playing {
    /* flex-direction: column; */
    gap: 15px;
    padding: 10px 15px;
  }

  .now-playing .track {
    width: 50%;
  }

  .now-playing .side .volume {
    display: none;
  }

  .now-playing .queue {
    right: 15px;
    width: calc(100vw - 30px);
  }
}
</style>
