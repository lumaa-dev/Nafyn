<template>
  <Transition name="np-slide">
    <div v-if="currentTrack" class="now-playing np-surface" :style="surfaceVars">
      <div class="np-bg" aria-hidden="true">
        <span v-for="(color, i) in bgColors" :key="i" :ref="setBlobRef(i)" class="blob" :style="{ background: color }" />
        <span class="scrim" />
      </div>

      <div class="track" @click="navigateTo('/now-playing')">
        <CoverImage :src="coverSrc(currentTrack)" eager />
        <span class="col">
          <span class="title">{{ currentTrack.title }}</span>
          <span class="artist">{{ currentTrack.artistName }}</span>
          <span v-if="isRemoteControlled" class="unity-badge">{{ $t('player.unity.playingOn', { device: masterDeviceLabel }) }}</span>
        </span>
      </div>

      <div class="controls">
        <div class="buttons">
          <button filled="hollow" class="round" :disabled="prevDisabled" :aria-label="$t('player.previous')" @click="prev()"><img src="../assets/icons/prev.svg" alt="" draggable="false" /></button>
          <button filled class="round" :aria-label="state.isPlaying ? $t('player.pause') : $t('player.play')" @click="togglePlay()">
            <img v-if="state.isPlaying" src="../assets/icons/pause.svg" alt="" draggable="false" />
            <img v-else src="../assets/icons/play.svg" alt="" draggable="false" />
          </button>
          <button filled="hollow" class="round" :disabled="!hasNext" :aria-label="$t('player.next')" @click="next()"><img src="../assets/icons/next.svg" alt="" draggable="false" /></button>
        </div>

        <PlayerSeek class="big" />
      </div>

      <div class="side big">
        <button filled="hollow" class="round" :aria-label="`${$t('player.showQueue')} (${upcomingCount})`" :aria-expanded="showQueue" @click="toggleQueue()"><span class="queue-count">{{ upcomingCount }}</span></button>

        <button :filled="state.repeat != 'off' ? '' : 'hollow'" class="round" :title="repeatTitle" :aria-label="repeatTitle" @click="cycleRepeat()">
          <img v-if="state.repeat === 'track'" src="../assets/icons/repeat-one.svg" alt="" draggable="false" />
          <img v-else src="../assets/icons/repeat.svg" alt="" draggable="false" />
        </button>

        <div class="volume">
          <button filled="hollow" class="round" :aria-label="state.muted || state.volume === 0 ? $t('player.unmute') : $t('player.mute')" @click="toggleMute()">
            <img v-if="state.muted || state.volume === 0" src="../assets/icons/volume-mute.svg" alt="" draggable="false" />
            <img v-else src="../assets/icons/volume.svg" alt="" draggable="false" />
          </button>
          <input type="range" min="0" max="1" step="0.01" :value="state.muted ? 0 : state.volume" :aria-label="$t('player.volume')" @input="setVolume(($event.target as HTMLInputElement).valueAsNumber)" />
        </div>
      </div>

      <!-- same panel as the Now Playing page: History above, the queue below -->
      <div class="queue big" v-if="showQueue">
        <QueuePanel />
      </div>
    </div>
  </Transition>
</template>

<script lang="ts" setup>
import QueuePanel from '~/components/panels/QueuePanel.vue';

const { t } = useI18n();
const { state, currentTrack, hasNext, hasPrev, role, masterStatus, masterDeviceLabel, togglePlay, next, prev, setVolume, toggleMute, cycleRepeat } = useUnity();

// true while this device is remote-controlling another device's playback (Nafyn Unity) rather than playing
// locally - transport controls above still work (they're relayed to the master), this just surfaces whose
// audio it actually is
const isRemoteControlled = computed(() => role.value === "slave" && masterStatus.value === "active");

// a computed boolean, not an inline `state.currentTime <= 3` in the template: reading the time there would
// re-render this whole bar on every playback tick, a boolean only when it actually flips
const prevDisabled = computed(() => !hasPrev.value && state.value.currentTime <= 3);

// the queue is what comes after the current track
const upcomingCount = computed(() => Math.max(0, state.value.queue.length - state.value.currentIndex - 1));

const showQueue = ref(false);
function toggleQueue() {
  showQueue.value = !showQueue.value;
}

// the bar leaves with the track (queue ran out, or it was stopped): don't reopen a stale dropdown next time
watch(currentTrack, (track) => { if (!track) showQueue.value = false; });

const { bgColors, surfaceVars, setBlobRef } = useCoverMeshGradient();

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
</script>

<style scoped>
.small {
  display: none;
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
  color: var(--np-text, #ffffff);
  transition: color 0.6s ease;
}

/* The bar slides up from the bottom edge when a track starts and back down when the queue ends. Plain ease-out
   in (decelerating into place) and ease-in out (accelerating away); the queue dropdown is a child, so it leaves
   with it. */
.np-slide-enter-active {
  transition: transform 0.3s ease-out, opacity 0.3s ease-out;
}

.np-slide-leave-active {
  transition: transform 0.25s ease-in, opacity 0.25s ease-in;
}

.np-slide-enter-from,
.np-slide-leave-to {
  transform: translateY(100%);
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .np-slide-enter-active,
  .np-slide-leave-active {
    transition: opacity 0.15s linear;
  }

  .np-slide-enter-from,
  .np-slide-leave-to {
    transform: none;
  }
}

/* dominant-color mesh gradient, driven by JS (usePlayer's audio analyser) - purely decorative, sits
   behind every control so it never gets in the way of the interface itself */
.now-playing .np-bg {
  position: absolute;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
}

.now-playing .np-bg .blob {
  position: absolute;
  left: 0;
  top: 0;
  width: min(38vw, 340px);
  height: min(38vw, 340px);
  border-radius: 50%;
  filter: blur(70px) saturate(160%);
  opacity: 0.8;
  /* moved by transform only (useCoverMeshGradient): its own layer, no layout or repaint per frame */
  will-change: transform, opacity;
  transition: background 0.8s ease;
}

/* fixed-contrast tint over the blobs, below the text - keeps the bar legible no matter how light/dark
   the cover's dominant colors are */
.now-playing .np-bg .scrim {
  position: absolute;
  inset: 0;
  background: var(--np-scrim, rgba(0, 0, 0, 0.6));
  transition: background 0.6s ease;
}

/* icon-only buttons: at least 44px square (WCAG 2.5.5) whatever the bar's font size */
.now-playing .round {
  width: max(2.4em, 44px);
  height: max(2.4em, 44px);
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
  color: color-mix(in srgb, var(--np-text, #ffffff) 90%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.now-playing .unity-badge {
  font-size: 0.7em;
  color: color-mix(in srgb, var(--np-text, #ffffff) 90%, transparent);
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
  min-width: 0;
  max-width: 600px;
}

.now-playing .buttons {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 15px;
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

/* The dropdown has its own solid near-black backdrop, independent of the gradient behind the bar, so it pins the
   fixed white scheme (text, inverse, icon filters) instead of following the cover. */
.now-playing .queue {
  --np-text: #ffffff;
  --np-text-inverse: #000000;
  --np-icon-fg: invert(1);
  --np-icon-inv: none;
  position: absolute;
  bottom: 110%;
  right: 30px;
  width: 320px;
  /* a definite height, not max-height: QueuePanel opens scrolled past the History, which needs it */
  height: min(50vh, 520px);
  padding: 10px;
  margin: 0;
  color: #ffffff;
  background: #000000ee;
  backdrop-filter: blur(20px);
  border: 1px solid #ffffff20;
  border-radius: 10px;
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
