<template>
  <div class="lyrics-panel" :class="{ sans: sansSerif }">
    <div ref="scrollContainer" class="lyrics-scroll np-quiet-scroll">
      <p v-if="loading" class="status">{{ $t('player.lyricsLoading') }}</p>
      <!-- a failed request (anything but 200 / 404) is told where the lyrics should have been, not as a toast -->
      <p v-else-if="errorMessage" class="status" role="alert">{{ errorMessage }}</p>
      <p v-else-if="!answer" class="status">{{ $t('player.lyricsUnavailable') }}</p>

      <!-- Braccato's renderer (@braccato/core): it builds the lines, follows the clock, scrolls this panel and seeks on a
           click. Kept connected whatever the state (v-show), since it is built once, when it connects. -->
      <braccato-lyrics v-show="answer && !loading" ref="view" class="lyrics-view" :style="viewStyle" />

      <!-- Unison's licence: credit Unison and whoever submitted the lyrics, both linked (the page is where a wrong
           line gets voted on or fixed). Shown at the end of the lyrics, not pinned on screen. -->
      <p v-if="answer?.credit && !loading" class="credit">
        <a :href="answer.credit.url" target="_blank" rel="noopener noreferrer">{{ answer.credit.text }}</a>
        <template v-if="answer.credit.submitter">
          <span aria-hidden="true"> · </span>
          <i18n-t keypath="player.lyricsSubmittedBy" tag="span">
            <template #name>
              <a :href="answer.credit.submitter.url" target="_blank" rel="noopener noreferrer">{{ answer.credit.submitter.name }}</a>
            </template>
          </i18n-t>
        </template>
      </p>
    </div>

    <!-- lyric offset: only timed lyrics have a timing to move. Below the lyrics rather than over them, so it never
         hides a line. -->
    <Transition name="offset-fade">
      <div v-if="answer && answer.syncType !== 'none' && !loading" class="offset" role="group" :aria-label="$t('player.lyricsOffset')">
        <button type="button" class="icon-only" filled="hollow" :aria-label="$t('player.lyricsEarlier')" :title="$t('player.lyricsEarlier')" @click="nudge(-OFFSET_STEP_MS)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none" /></svg>
        </button>
        <button type="button" class="value" filled="hollow" :disabled="offsetMs === 0" :aria-label="$t('player.lyricsOffsetReset', { value: offsetLabel })" :title="$t('player.lyricsOffsetReset', { value: offsetLabel })" @click="setOffset(0)">{{ offsetLabel }}</button>
        <button type="button" class="icon-only" filled="hollow" :aria-label="$t('player.lyricsLater')" :title="$t('player.lyricsLater')" @click="nudge(OFFSET_STEP_MS)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M12 5v14" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" fill="none" /></svg>
        </button>
      </div>
    </Transition>
  </div>
</template>

<script lang="ts" setup>
// The lyrics renderer is Braccato's (@braccato/core, https://github.com/better-lyrics/braccato): the <braccato-lyrics>
// custom element. This component only feeds it - the lyrics the server parsed with @braccato/parsers, the playback
// clock (from useUnity(), so a device that is not playing follows the one that is), the track's lyric offset - and
// gives it Nafyn's look through two themes (app/utils/lyricsThemes.ts). Everything else (which line is sung, the sweep,
// auto-scroll and its pause while the reader scrolls away, click-to-seek) is Braccato's.
import type { Lyric, LyricSyncType } from '@braccato/types';
import type { BraccatoLyricsElement } from '@braccato/core/element';
import '@braccato/core/styles/variables.css';
import '@braccato/core/styles/lyrics.css';
import '@braccato/core/styles/instrumental.css';
import type { Provider } from '~~/server/utils/lyrics/provider';
import { useAuthToken } from '~/composables/useAuthToken';
import { lyricsTheme } from '~/utils/lyricsThemes';

interface LyricsCredit {
  text: string;
  url: string;
  submitter?: { name: string; url: string } | null;
}

interface LyricsResponse {
  provider: Provider;
  syncType: LyricSyncType;
  lyrics: Lyric[];
  songwriters: string[];
  language?: string;
  credit?: LyricsCredit;
  offsetMs: number;
}

const OFFSET_STEP_MS = 100;

const { t } = useI18n();
const { currentTrack, state, seek } = useUnity();
const sansSerif = useLyricsSansSerif();

const answer = ref<LyricsResponse | null>(null);
const errorMessage = ref<string | null>(null);
const loading = ref(false);
const offsetMs = ref(0);
const scrollContainer = ref<HTMLElement | null>(null);
const view = ref<BraccatoLyricsElement | null>(null);
// true once @braccato/core/element has registered the tag: writing the element's properties before that would set
// plain fields that shadow its accessors for good
const ready = ref(false);
let requestSeq = 0;
let resetPlaybackClock: (() => void) | null = null;

const offsetLabel = computed(() => {
  const seconds = offsetMs.value / 1000;
  return `${seconds > 0 ? '+' : seconds < 0 ? '−' : ''}${Math.abs(seconds).toFixed(1)} s`;
});

// the credits line ("Written by A & B") takes its label from CSS; it is the only text Braccato writes itself
const viewStyle = computed(() => ({ '--blyrics-credits-label': JSON.stringify(t('player.lyricsWrittenBy')) }));

// ---------------------------------------------------------------------------------------------------------------
// The clock. `currentTime` only moves a few times a second (and on a remote device, once per Unity update), so the
// view is told the last real reading plus WHEN it was taken (`eventCreationTime`), and Braccato carries it forward
// itself. Re-anchored on every reading, on play/pause and on a seek, and written every frame while playing.
// ---------------------------------------------------------------------------------------------------------------
let anchorTime = 0;
let anchorWallMs = Date.now();
let rafId: number | null = null;
const reducedMotion = import.meta.client ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;

function syncAnchor() {
  anchorTime = state.value.currentTime;
  anchorWallMs = Date.now();
}

function pushClock() {
  const el = view.value;
  if (!ready.value || !el) return;
  el.tickOptions = {
    eventCreationTime: anchorWallMs,
    lyricOffset: offsetMs.value / 1000,
    // DESIGN.md "Animations": reduced motion keeps the fades, not the glide between lines
    smoothScroll: !reducedMotion?.matches,
    // a seek made while paused (here, or on the device that plays) moves the highlight too
    followPausedSeeks: true,
    // this view is ticked every frame, which would otherwise spend Braccato's "one scroll held back" on the
    // reader's own scroll: scrolling away has to pause auto-scroll at once
    countEveryUserScroll: true,
  };
  if (el.playing !== state.value.isPlaying) el.playing = state.value.isPlaying;
  el.currentTime = anchorTime;
}

function frame() {
  pushClock();
  rafId = requestAnimationFrame(frame);
}

// only while playing: a paused view has nothing to move, and a loop for nothing is idle cost on a phone
function startLoop() {
  if (rafId === null && ready.value) rafId = requestAnimationFrame(frame);
}

function stopLoop() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
}

watch(() => state.value.currentTime, () => { syncAnchor(); if (rafId === null) pushClock(); });
watch(() => state.value.isPlaying, (playing) => {
  syncAnchor();
  pushClock();
  if (playing) startLoop(); else stopLoop();
});

// ---------------------------------------------------------------------------------------------------------------
// The lyrics
// ---------------------------------------------------------------------------------------------------------------
function applyLyrics() {
  const el = view.value;
  if (!ready.value || !el) return;
  const found = answer.value;
  el.lyricsOptions = {
    songKey: currentTrack.value?.id,
    songwriters: found?.songwriters ?? [],
    language: found?.language ?? null,
  };
  // an empty array clears the view
  el.lyrics = found?.lyrics ?? [];
  pushClock();
}

async function loadLyrics(id: string | null) {
  const seq = ++requestSeq;
  answer.value = null;
  errorMessage.value = null;
  offsetMs.value = 0;
  // a new song: Braccato's clock must not read the jump to its start as a seek inside the last one
  resetPlaybackClock?.();
  applyLyrics();
  if (scrollContainer.value) scrollContainer.value.scrollTop = 0;

  if (!id) return;
  const token = useAuthToken().token.value;
  if (!token) return;

  loading.value = true;
  try {
    const res = await $fetch<LyricsResponse>(`/api/v1/library/${id}/lyrics`, { headers: { Authorization: token }, timeout: 120_000 });
    if (seq !== requestSeq) return;
    answer.value = res;
    offsetMs.value = res.offsetMs ?? 0;
  } catch (e) {
    if (seq !== requestSeq) return;
    // a 404 is the normal "no lyrics for this track"; anything else (rate limit, provider down, timeout) is a failure
    // worth saying - in the panel itself, since the screen change (the lyrics) is what didn't happen
    if ((e as { statusCode?: number })?.statusCode !== 404) errorMessage.value = apiErrorMessage(e);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }

  if (seq !== requestSeq) return;
  // built once the view is shown (v-show): Braccato measures the lines as it builds them, and a hidden view
  // measures nothing
  await nextTick();
  if (seq !== requestSeq) return;
  syncAnchor();
  applyLyrics();
}

watch(() => currentTrack.value?.id ?? null, (id) => loadLyrics(id), { immediate: true });

// ---------------------------------------------------------------------------------------------------------------
// The lyric offset: shown at once, saved with the track's cached lyrics once the clicks stop
// ---------------------------------------------------------------------------------------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function nudge(deltaMs: number) {
  setOffset(offsetMs.value + deltaMs);
}

function setOffset(value: number) {
  offsetMs.value = Math.max(-30_000, Math.min(30_000, Math.round(value)));
  pushClock();

  const id = currentTrack.value?.id;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const token = useAuthToken().token.value;
    if (!id || !token) return;
    try {
      await $fetch(`/api/v1/library/${id}/lyrics/offset`, { method: 'PUT', headers: { Authorization: token }, body: { offsetMs: offsetMs.value } });
    } catch (e) {
      // the lyrics already moved here; what failed is keeping it for the next play - a red toast (DESIGN.md "Error messages")
      useToast().sendError(t('player.lyricsOffsetError'), e);
    }
  }, 400);
}

// ---------------------------------------------------------------------------------------------------------------
// The element
// ---------------------------------------------------------------------------------------------------------------
watch(sansSerif, () => { if (ready.value && view.value) view.value.theme = lyricsTheme({ sansSerif: sansSerif.value }); });

onMounted(async () => {
  // the tag only exists in a browser (it extends HTMLElement), so it is registered here, never during SSR
  const [, core] = await Promise.all([import('@braccato/core/element'), import('@braccato/core')]);
  resetPlaybackClock = core.resetPlaybackClock;
  await customElements.whenDefined('braccato-lyrics');
  const el = view.value;
  if (!el) return;

  el.host = {
    // the panel scrolls, not the page (DESIGN.md "Now Playing": the page never scrolls)
    getScrollElement: () => scrollContainer.value,
    // Braccato hands the PLAYER's time (the offset already taken back out); unsynced lines have none to go to
    seek: (timeS: number) => { if (answer.value && answer.value.syncType !== 'none') seek(timeS); },
  };
  el.theme = lyricsTheme({ sansSerif: sansSerif.value });
  ready.value = true;

  syncAnchor();
  applyLyrics();
  if (state.value.isPlaying) startLoop();
});

onBeforeUnmount(() => {
  stopLoop();
  if (saveTimer) clearTimeout(saveTimer);
});
</script>

<style scoped>
.lyrics-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  /* Lyrics are Instrument Serif; the setting switches them to Braccato's own sans stack (app/utils/lyricsThemes.ts) */
  font-family: "Instrument-Serif", serif;
}

.lyrics-panel.sans {
  font-family: var(--blyrics-default-font-family, sans-serif);
}

.lyrics-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* DESIGN.md "Now Playing": a small smooth fade at the top and bottom edges. Declared to Braccato too, as scroll
     padding, so the line being sung is kept inside the band that is fully visible. */
  mask-image: linear-gradient(to bottom, transparent 0, #000 30px, #000 calc(100% - 30px), transparent 100%);
  scroll-padding-block: 30px;
}

.lyrics-view {
  display: block;
}

.lyrics-panel .status {
  color: color-mix(in srgb, var(--np-text, #ffffff) 90%, transparent);
  text-align: center;
  margin-top: 20px;
}

/* links are underlined italic Instrument Serif (DESIGN.md "Links"); the colour is --np-text so it keeps the
   contrast the cover-driven surface picked */
.lyrics-panel .credit {
  margin: 0;
  padding: 8px 4px 24px;
  color: color-mix(in srgb, var(--np-text, #ffffff) 90%, transparent);
}

.lyrics-panel .credit a {
  color: var(--np-text, #ffffff);
  font-style: italic;
  text-decoration: underline;
}

.offset {
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 4px 0;
  font-size: 0.75em;
}

.offset button.icon-only {
  width: 36px;
  height: 36px;
  min-width: 36px;
  border-width: 1px;
  border-style: solid;
  border-color: var(--np-text, #ffffff);
}

.offset button.icon-only svg {
  width: 60%;
  height: 60%;
}

.offset button.value {
  min-width: 5.5em;
  padding-block: 0.35em;
  padding-inline: 0.8em;
  font-variant-numeric: tabular-nums;
}

.offset-fade-enter-active,
.offset-fade-leave-active {
  transition: opacity 0.2s ease-out;
}

.offset-fade-enter-from,
.offset-fade-leave-to {
  opacity: 0;
}
</style>

<style>
/* Settings -> Appearance -> OpenDyslexic replaces every font of the app with !important, the lyrics excepted: they
   stay in Instrument Serif or, with "sans-serif lyrics" on, Braccato's own font. More specific than the global
   `html.dyslexic-font *` rule, so this one wins. */
html.dyslexic-font .lyrics-panel,
html.dyslexic-font .lyrics-panel *:not(.blyrics-container, .blyrics-container *) {
  font-family: "Instrument-Serif", serif !important;
}

html.dyslexic-font .lyrics-panel.sans,
html.dyslexic-font .lyrics-panel.sans *:not(.blyrics-container, .blyrics-container *) {
  font-family: var(--blyrics-default-font-family, sans-serif) !important;
}

html.dyslexic-font .lyrics-panel .blyrics-container,
html.dyslexic-font .lyrics-panel .blyrics-container * {
  font-family: var(--blyrics-font-family, var(--blyrics-default-font-family)) !important;
}
</style>
