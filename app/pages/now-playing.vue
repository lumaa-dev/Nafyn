<template>
  <div v-if="currentTrack" class="npp np-surface" :class="{ info: showInfo }" :style="surfaceVars">
    <div class="np-bg" aria-hidden="true">
      <span v-for="(color, i) in bgColors" :key="i" :ref="setBlobRef(i)" class="blob" :style="{ background: color }" />
      <span class="scrim" />
    </div>

    <!-- left panel: the primary song information. It cannot be changed. On a small or vertical screen the song info
         becomes one of the toggles and the playback controls stay attached at the bottom (DESIGN.md "Now Playing") -->
    <div class="left">
      <div class="song-info">
        <CoverImage class="cover" :src="coverSrc(currentTrack, 500)" eager />

        <div class="meta">
          <h1 class="title">{{ currentTrack.title }}</h1>
          <p class="artist">{{ currentTrack.artistName }}</p>
        </div>
      </div>

      <div class="transport">
        <div class="seek">
          <span class="time">{{ formatDuration(state.currentTime) }}</span>
          <input type="range" min="0" :max="state.duration || 0" step="1" :value="state.currentTime" :aria-label="$t('player.seek')" @input="seek(($event.target as HTMLInputElement).valueAsNumber)" />
          <span class="time">{{ formatDuration(state.duration) }}</span>
        </div>

        <div class="controls">
          <button filled="hollow" class="round" :disabled="!hasPrev && state.currentTime <= 3" :aria-label="$t('player.previous')" @click="prev()"><img src="../assets/icons/prev.svg" alt="" draggable="false" /></button>
          <button filled class="round big" :aria-label="state.isPlaying ? $t('player.pause') : $t('player.play')" @click="togglePlay()">
            <img v-if="state.isPlaying" src="../assets/icons/pause.svg" alt="" draggable="false" />
            <img v-else src="../assets/icons/play.svg" alt="" draggable="false" />
          </button>
          <button filled="hollow" class="round" :disabled="!hasNext" :aria-label="$t('player.next')" @click="next()"><img src="../assets/icons/next.svg" alt="" draggable="false" /></button>
        </div>

        <div class="volume">
          <button filled="hollow" class="round" :aria-label="state.muted || state.volume === 0 ? $t('player.unmute') : $t('player.mute')" @click="toggleMute()">
            <img v-if="state.muted || state.volume === 0" src="../assets/icons/volume-mute.svg" alt="" draggable="false" />
            <img v-else src="../assets/icons/volume.svg" alt="" draggable="false" />
          </button>
          <input type="range" min="0" max="1" step="0.01" :value="state.muted ? 0 : state.volume" :aria-label="$t('player.volume')" @input="setVolume(($event.target as HTMLInputElement).valueAsNumber)" />
        </div>

        <div v-if="isRemoteControlled" class="unity-badge">
          <p>{{ $t('player.unity.playingOn', { device: masterDeviceLabel }) }}</p>
          <button type="button" filled="hollow" class="unity-takeover" @click="takeover()">{{ $t('player.unity.playHere') }}</button>
        </div>
      </div>
    </div>

    <div class="right">
      <div class="tabs">
        <button class="tab-song" :filled="showInfo ? '' : 'hollow'" :aria-pressed="showInfo" @click="showInfo = true">{{ $t('player.song') }}</button>
        <button v-for="panel in nowPlayingPanels" :key="panel.id" :filled="!showInfo && activePanelId === panel.id ? '' : 'hollow'" :aria-pressed="!showInfo && activePanelId === panel.id" @click="activePanelId = panel.id; showInfo = false">{{ $t(panel.label) }}</button>
      </div>

      <div class="panel np-quiet-scroll">
        <component :is="activePanel.component" v-if="activePanel" />
      </div>
    </div>
  </div>

  <div v-else class="npp empty">
    <p>{{ $t('player.nothingPlaying') }}</p>
  </div>
</template>

<script lang="ts" setup>
import { nowPlayingPanels } from '~/composables/useNowPlayingPanels';

const { state, currentTrack, hasNext, hasPrev, role, masterStatus, masterDeviceLabel, takeover, togglePlay, next, prev, seek, setVolume, toggleMute } = useUnity();
const { bgColors, surfaceVars, setBlobRef } = useCoverMeshGradient();

const isRemoteControlled = computed(() => role.value === "slave" && masterStatus.value === "active");

const activePanelId = ref(nowPlayingPanels[0]?.id);
// only used on a small or vertical screen, where the song info is a panel of its own (the toggles replace the tabs)
const showInfo = ref(false);
const activePanel = computed(() => nowPlayingPanels.find(p => p.id === activePanelId.value));

// The queue ran out (or was stopped) while this page was open: there is nothing left to show, and the page would
// otherwise sit on "nothing playing". Only when a track actually went away - opening the page directly with
// nothing playing keeps the empty state.
watch(() => !!currentTrack.value, (hasTrack, hadTrack) => {
  if (hadTrack && !hasTrack) navigateTo("/");
});

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
</script>

<style scoped>
/* This element IS `.view` (see app.vue), so its margin is the clearance for the fixed Header and the sidebar
   column. Setting `margin` here - `margin: ... auto` to centre - used to drop both: the page slid under the
   sidebar on laptop widths. Only the size is set; the box sits where `.view` puts it. */
.npp {
  position: relative;
  display: flex;
  flex-direction: row;
  gap: clamp(24px, 4vw, 60px);
  /* margin-top + height + margin-bottom of `.view` add up to exactly the viewport, so the document is never taller
     than 100vh; dvh so a mobile browser's collapsing toolbar can't push the controls off-screen */
  height: calc(100dvh - (15vh - 10px) - 1.2em);
  /* never taller or wider than the screen (DESIGN.md "Now Playing"): nothing on this page scrolls, `.view` adds no
     bottom margin, and the app's own page scrollbar is switched off for it (app.vue) */
  width: 100%;
  overflow: hidden;
  min-height: 0;
  max-height: calc(100dvh - (15vh - 10px) - 1.2em);
  padding-bottom: 0;
  color: var(--np-text, #ffffff);
  transition: color 0.6s ease;
}

.npp.empty {
  align-items: center;
  justify-content: center;
  color: #ffffff;
}

/* dominant-color mesh gradient, driven by JS (usePlayer's audio analyser) - purely decorative, sits
   behind every control so it never gets in the way of the interface itself. Fixed to the viewport
   (not `.npp`'s own box) so it fills the whole page top to bottom, not just the player card. */
.npp .np-bg {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
}

.npp .np-bg .blob {
  position: absolute;
  left: 0;
  top: 0;
  width: min(32vw, 420px);
  height: min(32vw, 420px);
  border-radius: 50%;
  filter: blur(90px) saturate(160%);
  opacity: 0.8;
  /* moved by transform only (useCoverMeshGradient): its own layer, no layout or repaint per frame */
  will-change: transform, opacity;
  transition: background 0.8s ease;
}

/* fixed-contrast tint over the blobs, below the text - keeps the page legible no matter how light/dark
   the cover's dominant colors are */
.npp .np-bg .scrim {
  position: absolute;
  inset: 0;
  background: var(--np-scrim, rgba(0, 0, 0, 0.6));
  transition: background 0.6s ease;
}

/* DESIGN.md "Now Playing": two panels on a large horizontal screen, each AT MOST half of the width - 50% is a ceiling,
   not a size. The song information takes the width of its cover and controls; the right panel the width it asks for
   (up to the same half). What is left over is air around them, not a wider panel. */
.npp {
  justify-content: center;
}

.npp .left {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  flex: 0 1 auto;
  max-width: 50%;
  min-width: 0;
  min-height: 0;
  gap: clamp(10px, 2.2vh, 25px);
}

/* follows the height, not just the width: on a short laptop screen a 380px cover plus its controls is taller
   than the page, and the artist and the transport buttons are what got cut off */
.npp .song-info,
.npp .transport {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: clamp(260px, 40vh, 380px);
  max-width: 100%;
  min-width: 0;
  gap: clamp(10px, 2.2vh, 25px);
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
  min-width: 0;
}

/* a long title or artist wraps to two lines instead of being cut at one */
.npp .title,
.npp .artist {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.npp .title {
  font-size: 1.4em;
  line-height: 1.15;
}

.npp .artist {
  font-family: "Instrument-Italic";
  color: color-mix(in srgb, var(--np-text, #ffffff) 90%, transparent);
  line-height: 1.2;
}

.npp .unity-badge {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
}

.npp .unity-badge p {
  font-size: 0.8em;
  color: color-mix(in srgb, var(--np-text, #ffffff) 90%, transparent);
  max-width: 100%;
  text-align: center;
  overflow-wrap: break-word;
}

.npp .unity-takeover {
  font-size: 0.85em;
  max-width: 100%;
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
  min-width: 0;
}

.npp .time {
  color: color-mix(in srgb, var(--np-text, #ffffff) 90%, transparent);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-discy);
  font-size: 0.7em;
  width: 2.5em;
}

.npp .controls {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 20px;
}

.npp .volume {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 10px;
  width: 100%;
}

.npp .volume input[type="range"] {
  flex: 1;
  min-width: 0;
}

.npp .volume .round {
  width: max(2em, 44px);
  height: max(2em, 44px);
}

/* icon-only buttons: at least 44px square (WCAG 2.5.5) at any font size */
.npp .round {
  width: max(2.4em, 44px);
  height: max(2.4em, 44px);
  border-radius: 50%;
  padding: 0 !important;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.npp .round.big {
  width: max(3.2em, 56px);
  height: max(3.2em, 56px);
}

.npp .round img {
  width: 1.1em;
  height: 1.1em;
}

.npp .round.big img {
  width: 1.3em;
  height: 1.3em;
}

.npp .right {
  display: flex;
  flex-direction: column;
  gap: 20px;
  flex: 0 1 560px;
  max-width: 50%;
  min-width: 0;
  min-height: 0;
}

.npp .tabs {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: 10px;
  flex-shrink: 0;
}

.npp .tabs button {
  font-size: 0.7em;
  min-width: 0;
}

.npp .panel {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

/* the song info is a toggle only where the panels stack */
.npp .tab-song {
  display: none;
}

/* short laptop screens (13" at default scaling is ~700-800px of viewport) */
@media screen and (max-height: 800px) and (min-width: 801px) {
  .npp .title {
    font-size: 1.15em;
  }

  .npp .round.big {
    width: max(2.7em, 52px);
    height: max(2.7em, 52px);
  }

  .npp .controls {
    gap: 14px;
  }
}

/* small screens and large vertical screens: one panel at a time, the toggles replace the tabs, and the page itself
   never scrolls - only the contents of a panel do. The playback controls are not part of any panel: they stay
   attached at the bottom, compact. `display: contents` lets the song info, the panels and the transport be
   ordered as siblings. */
@media screen and (max-width: 800px), screen and (orientation: portrait) {
  .npp {
    flex-direction: column;
    align-items: center;
    gap: 14px;
    /* `.view` clears a taller Header here (20vh) */
    height: calc(100dvh - (20vh - 10px) - 1.2em);
    max-height: calc(100dvh - (20vh - 10px) - 1.2em);
  }

  .npp .left,
  .npp .right {
    display: contents;
  }

  .npp .tab-song {
    display: inline-block;
  }

  .npp .tabs {
    order: 0;
    justify-content: center;
  }

  .npp .song-info {
    order: 1;
    flex: 1 1 0;
    width: min(100%, 520px);
    min-height: 0;
    justify-content: center;
  }

  /* as wide as the space allows, never taller than it */
  .npp .cover {
    width: auto;
    max-width: 100%;
    flex: 0 1 auto;
    min-height: 0;
    max-height: 100%;
    height: min(100%, 100vw);
  }

  .npp .panel {
    order: 1;
    flex: 1 1 0;
    width: min(100%, 520px);
    min-height: 0;
    height: auto;
  }

  .npp .transport {
    order: 2;
    width: min(100%, 520px);
    gap: 8px;
  }

  .npp.info .panel {
    display: none;
  }

  .npp:not(.info) .song-info {
    display: none;
  }

  .npp .round.big {
    width: max(2.7em, 52px);
    height: max(2.7em, 52px);
  }
}
</style>
