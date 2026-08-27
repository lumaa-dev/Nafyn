<template>
  <Teleport to="body">
    <div v-if="open" class="reel" @click="advance">
      <div class="bars">
        <span v-for="(_, i) in slides" :key="i" class="bar">
          <span class="fill" :class="{ done: i < index, active: i === index }" />
        </span>
      </div>

      <button type="button" class="close" :aria-label="$t('insights.reel.close')" @click.stop="close">&times;</button>

      <div v-if="slide" class="slide" :key="index">
        <img v-if="slide.cover" :src="slide.cover" alt="" class="art" @error="onArtError">

        <p v-if="slide.label" class="caption">{{ $t(slide.label) }}</p>
        <p v-if="slide.value && slide.kind === 'stat'" class="big">{{ slide.value }}</p>
        <p v-if="slide.title" class="title">{{ slide.title }}</p>
        <p v-if="slide.subtitle && slide.kind === 'track'" class="subtitle">{{ slide.subtitle }}</p>
        <p v-if="slide.value && slide.kind === 'intro'" class="big">{{ slide.value }}</p>
        <p v-if="slide.value && slide.kind === 'outro'" class="big">{{ slide.value }}</p>
      </div>

      <p class="hint">{{ $t('insights.reel.tapHint') }}</p>
    </div>
  </Teleport>
</template>

<script lang="ts" setup>
import noCover from '~/assets/no-cover.png';
import { setTrackingSuppressed } from '~/composables/usePlayTracking';
import type { ReelSlide } from '~/composables/useInsights';

// The in-app highlight reel: a tap-through story of the year's headline numbers, with a short excerpt of
// each top track playing underneath its slide.
//
// It runs its own <audio> element rather than going through usePlayer, for two reasons: the reel must not
// clobber whatever queue the user had going, and its excerpts must not be recorded as listens. Twenty
// six-second clips would otherwise land in the event store as twenty sub-30-second plays and skew the very
// data being celebrated - hence setTrackingSuppressed() around the whole session.
const props = defineProps<{ slides: ReelSlide[] }>();

const SLIDE_MS = 6000;

const open = ref(false);
const index = ref(0);
const slides = computed(() => props.slides);
const slide = computed(() => slides.value[index.value] ?? null);

let audio: HTMLAudioElement | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;

const player = usePlayer();

function stopAudio() {
  if (!audio) return;
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
}

function playExcerpt(current: ReelSlide) {
  stopAudio();
  if (!current.trackId || !import.meta.client) return;

  const token = useCookie("nafynToken").value ?? "";
  audio ??= new Audio();
  audio.src = `/api/v1/library/${current.trackId}/stream?token=${encodeURIComponent(token)}`;
  audio.currentTime = 0;

  // seeking has to wait for enough of the file to be readable; without this the excerpt starts from zero
  audio.addEventListener("loadedmetadata", () => {
    if (audio && current.excerptStartSeconds) audio.currentTime = current.excerptStartSeconds;
  }, { once: true });

  audio.play().catch(() => {
    // autoplay refused (no user gesture yet, or the file is gone) - the slide still shows, silently
  });
}

function scheduleNext() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(advance, SLIDE_MS);
}

function advance() {
  if (index.value >= slides.value.length - 1) {
    close();
    return;
  }
  index.value++;
}

function start() {
  if (slides.value.length === 0) return;

  // the reel takes over the audio output; leaving the main player running would mean two tracks at once
  if (player.state.value.isPlaying) player.togglePlay();

  setTrackingSuppressed(true);
  index.value = 0;
  open.value = true;
}

function close() {
  open.value = false;
  if (timer) clearTimeout(timer);
  timer = null;
  stopAudio();
  setTrackingSuppressed(false);
}

// every slide change restarts both the excerpt and the auto-advance timer
watch([open, index], () => {
  if (!open.value || !slide.value) return;
  playExcerpt(slide.value);
  scheduleNext();
});

function onEscape(e: KeyboardEvent) {
  if (e.key === "Escape") close();
}

onMounted(() => window.addEventListener("keydown", onEscape));

// suppression is process-wide, so leaving it on after the component goes away would silently stop recording
// every subsequent listen
onUnmounted(() => {
  window.removeEventListener("keydown", onEscape);
  close();
});

function onArtError(e: Event) {
  (e.target as HTMLImageElement).src = noCover;
}

defineExpose({ start, close });
</script>

<style>
.reel {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: #1a1a18;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
  padding: 40px 24px;
  cursor: pointer;
  user-select: none;
}

.reel .bars {
  position: absolute;
  top: 14px;
  left: 14px;
  right: 14px;
  display: flex;
  gap: 4px;
}

.reel .bar {
  flex: 1;
  height: 3px;
  border-radius: 2px;
  background: #ffffff26;
  overflow: hidden;
}

.reel .bar .fill {
  display: block;
  height: 100%;
  width: 0;
  background: #e18c46;
}

.reel .bar .fill.done { width: 100%; }
.reel .bar .fill.active {
  width: 100%;
  animation: reel-progress 6s linear forwards;
}

@keyframes reel-progress {
  from { width: 0; }
  to { width: 100%; }
}

.reel .close {
  position: absolute;
  top: 26px;
  right: 20px;
  background: none;
  border: none;
  color: #ffffffae;
  font-size: 1.6em;
  line-height: 1;
  cursor: pointer;
}

.reel .slide {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
  max-width: 520px;
  animation: reel-in 0.45s ease;
}

@keyframes reel-in {
  from { opacity: 0; transform: translateY(14px) scale(0.98); }
  to { opacity: 1; transform: none; }
}

.reel .art {
  width: 220px;
  height: 220px;
  border-radius: 14px;
  object-fit: cover;
  background: #00000040;
  margin-bottom: 8px;
}

.reel .caption {
  font-size: 0.75em;
  color: #e18c46;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.reel .big {
  font-family: "Discy";
  font-size: 3em;
  line-height: 1.05;
}

.reel .title {
  font-family: "Instrument-Italic";
  font-size: 1.5em;
}

.reel .subtitle {
  font-size: 0.9em;
  color: #999999;
}

.reel .hint {
  position: absolute;
  bottom: 26px;
  font-size: 0.65em;
  color: #666666;
}

@media screen and (max-width: 800px) {
  .reel .art { width: 160px; height: 160px; }
  .reel .big { font-size: 2.2em; }
}
</style>
