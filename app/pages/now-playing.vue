<template>
  <div class="npp" v-if="currentTrack">
    <div class="left">
      <img class="cover" :src="(currentTrack.coverArt ?? noCover).replace('front-250', 'front-1000')" @error="($event.target as HTMLImageElement).src = noCover" draggable="false" loading="lazy" />

      <div class="meta">
        <h1 class="title">{{ currentTrack.title }}</h1>
        <p class="artist">{{ currentTrack.artistName }}</p>
      </div>

      <div class="seek">
        <span class="time">{{ formatDuration(state.currentTime) }}</span>
        <input type="range" min="0" :max="state.duration || 0" step="1" :value="state.currentTime" @input="seek(($event.target as HTMLInputElement).valueAsNumber)" />
        <span class="time">{{ formatDuration(state.duration) }}</span>
      </div>

      <div class="controls">
        <button filled="hollow" class="round" :disabled="!hasPrev && state.currentTime <= 3" @click="prev()"><img src="../assets/icons/prev.svg" draggable="false" /></button>
        <button filled class="round big" @click="togglePlay()">
          <img v-if="state.isPlaying" src="../assets/icons/pause.svg" draggable="false" />
          <img v-else src="../assets/icons/play.svg" draggable="false" />
        </button>
        <button filled="hollow" class="round" :disabled="!hasNext" @click="next()"><img src="../assets/icons/next.svg" draggable="false" /></button>
      </div>
    </div>

    <div class="right">
      <div class="tabs">
        <button v-for="panel in nowPlayingPanels" :key="panel.id" :filled="activePanelId === panel.id ? '' : 'hollow'" @click="activePanelId = panel.id">{{ $t(panel.label) }}</button>
      </div>

      <div class="panel">
        <component :is="activePanel.component" v-if="activePanel" />
      </div>
    </div>
  </div>

  <div class="npp empty" v-else>
    <p>{{ $t('player.nothingPlaying') }}</p>
  </div>
</template>

<script lang="ts" setup>
import noCover from '../assets/no-cover.png';
import { nowPlayingPanels } from '~/composables/useNowPlayingPanels';

const { state, currentTrack, hasNext, hasPrev, togglePlay, next, prev, seek } = usePlayer();

const activePanelId = ref(nowPlayingPanels[0]?.id);
const activePanel = computed(() => nowPlayingPanels.find(p => p.id === activePanelId.value));

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
</script>

<style scoped>
.npp {
  display: flex;
  flex-direction: row;
  gap: 60px;
  max-width: 1100px;
  margin: calc(15vh - 10px) auto;
  height: calc(70vh - 10px);
  padding-bottom: 0;
}

.npp.empty {
  align-items: center;
  justify-content: center;
  color: #666666;
}

.npp .left {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 380px;
  flex-shrink: 0;
  gap: 25px;
}

.npp .cover {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 15px;
  background: #00000040;
  box-shadow: 0 20px 60px #00000060;
}

.npp .meta {
  text-align: center;
  width: 100%;
  overflow: hidden;
}

.npp .title {
  font-size: 1.4em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.npp .artist {
  font-family: "Instrument-Italic";
  color: #ffffffae;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.npp .seek {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.npp .seek input[type="range"] {
  flex: 1;
}

.npp .time {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  font-size: 0.7em;
  width: 2.5em;
}

.npp .controls {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 20px;
}

.npp .round {
  width: 2.4em;
  height: 2.4em;
  border-radius: 50%;
  padding: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.npp .round.big {
  width: 3.2em;
  height: 3.2em;
}

.npp .round img {
  width: 1.1em;
  height: 1.1em;
  transition: filter 0.15s ease-out;
}

.npp .round.big img {
  width: 1.3em;
  height: 1.3em;
}

button[filled="hollow"].round img {
  filter: invert();
}

button[filled="hollow"].round:not(:disabled):hover img {
  filter: none;
}

.npp input[type="range"] {
  appearance: none;
  height: 4px;
  border-radius: 250px;
  background: #ffffff30;
  outline: none;
}

.npp input[type="range"]::-webkit-slider-thumb {
  -webkit-appearance: none;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #ffffffae;
  cursor: pointer;
}

.npp .right {
  display: flex;
  flex-direction: column;
  gap: 20px;
  flex: 1;
  min-width: 0;
}

.npp .tabs {
  display: flex;
  flex-direction: row;
  gap: 10px;
}

.npp .tabs button {
  font-size: 0.7em;
}

.npp .panel {
  flex: 1;
  overflow-y: auto;
}

@media screen and (max-width: 800px) {
  .npp {
    flex-direction: column;
    align-items: center;
    gap: 30px;
  }

  .npp .cover {
    width: 80%;
    aspect-ratio: 1 / 1;
  }

  .npp .seek {
    width: 90%;
  }

  .npp .left {
    width: 90%;
    max-width: 380px;
  }

  .npp .right {
    width: 90%;
  }
}
</style>
