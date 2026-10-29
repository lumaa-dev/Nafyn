<template>
  <div ref="scrollContainer" class="lyrics-panel np-quiet-scroll">
    <p v-if="loading" class="status">{{ $t('player.lyricsLoading') }}</p>
    <p v-else-if="!paragraphs || !kind" class="status">{{ $t('player.lyricsUnavailable') }}</p>

    <pre v-else-if="kind === 'static'" class="static">{{ staticText }}</pre>

    <ol v-else class="lines">
      <li
        v-for="(line, index) in lines"
        :key="line.id"
        :ref="(el) => setLineRef(el as HTMLElement | null, index)"
        :class="{ active: activeIndices.includes(index), bg: line.type.kind === 'background', gap: line.firstInParagraph }"
        :nafyn-start="line.startTime"
        :nafyn-end="line.endTime"
        @click="clickLyric(line)"
      >
        <template v-if="kind === 'beat' && activeIndices.includes(index)">
          <span v-for="segment in line.segments" :key="segment.id" class="segment" :style="segmentStyle(segment)">{{ segment.text }}{{ segment.endsWord ? ' ' : '' }}</span>
        </template>
        <template v-else>{{ line.text }}</template>
      </li>
    </ol>
  </div>
</template>

<script lang="ts" setup>
import { isStatic, isBeatByBeat, type Provider, type LyricParagraphs, type LyricLine, type LyricSegment } from '~~/server/utils/lyrics/parser';
import { useAuthToken } from '~/composables/useAuthToken';

interface LyricsResponse {
  provider: Provider;
  paragraphs: LyricParagraphs;
}

interface FlatLine extends LyricLine {
  firstInParagraph: boolean;
}

type LyricsKind = 'static' | 'paragraph' | 'beat';

const { currentTrack, state } = useUnity();

const paragraphs = ref<LyricParagraphs | null>(null);
const loading = ref(false);
const scrollContainer = ref<HTMLElement | null>(null);
const autoScrollEnabled = ref(true);
let lineRefs: (HTMLElement | null)[] = [];
let observer: IntersectionObserver | null = null;
let requestSeq = 0;

// `timeupdate` only fires a handful of times per second (browser-dependent, not
// evenly spaced), which makes anything driven directly off it look stepped/jittery.
// Interpolate between ticks with rAF, using each real `currentTime` update as a
// correction anchor so drift never accumulates beyond one tick's worth.
const displayedTime = ref(0);
let rafId: number | null = null;
let anchorAudioTime = 0;
let anchorPerfTime = 0;

function syncTimeAnchor() {
  anchorAudioTime = state.value.currentTime;
  anchorPerfTime = performance.now();
  displayedTime.value = anchorAudioTime;
}

// Only runs while audio is actually playing: a paused (or hidden - the browser stops rAF there anyway) panel
// has nothing to interpolate, and a loop that re-renders the lyrics 60 times a second for nothing is exactly the
// kind of idle cost that adds up on a phone.
function tick() {
  displayedTime.value = anchorAudioTime + (performance.now() - anchorPerfTime) / 1000;
  rafId = requestAnimationFrame(tick);
}

function startLoop() {
  if (rafId !== null) return;
  syncTimeAnchor();
  rafId = requestAnimationFrame(tick);
}

function stopLoop() {
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
  syncTimeAnchor();
}

function clickLyric(line: LyricLine) {
  const { seek } = useUnity();
  seek(line.startTime);
}

watch(() => state.value.currentTime, syncTimeAnchor);

const kind = computed<LyricsKind | null>(() => {
  if (!paragraphs.value || paragraphs.value.length === 0) return null;
  if (isBeatByBeat(paragraphs.value)) return 'beat';
  if (isStatic(paragraphs.value)) return 'static';
  return 'paragraph';
});

const lines = computed<FlatLine[]>(() => {
  if (!paragraphs.value) return [];
  const out: FlatLine[] = [];
  for (const paragraph of paragraphs.value) {
    paragraph.lines.forEach((line, i) => out.push({ ...line, firstInParagraph: i === 0 }));
  }
  return out;
});

const staticText = computed(() =>
  paragraphs.value?.map((p) => p.lines.map((l) => l.text).join('\n')).join('\n\n') ?? ''
);

// main + background lines can be simultaneously active (they overlap in time), so
// this tracks every active line rather than a single index
//
// Returns the previous array when nothing changed: a fresh array every frame would count as a change and
// re-render the whole lyric list 60 times a second, where it only needs to when a line starts or ends.
const activeIndices = computed<number[]>((previous) => {
  const time = displayedTime.value;
  const out: number[] = [];
  lines.value.forEach((line, i) => { if (time >= line.startTime && time < line.endTime) out.push(i); });
  return previous && previous.length === out.length && previous.every((value, i) => value === out[i]) ? previous : out;
});

// the line auto-scroll/observer follow: the main line if active, else whichever line is
const activeIndex = computed(() => {
  const indices = activeIndices.value;
  if (indices.length === 0) return -1;
  return indices.find((i) => lines.value[i].type.kind === 'main') ?? indices[0];
});

function segmentStyle(segment: LyricSegment) {
  const duration = segment.endTime - segment.startTime;
  const progress = duration > 0 ? Math.min(1, Math.max(0, (displayedTime.value - segment.startTime) / duration)) : 1;
  return {
    backgroundPositionX: `${((1 - progress) * 100).toFixed(2)}%`
  };
}

function setLineRef(el: HTMLElement | null, index: number) {
  lineRefs[index] = el;
}

function scrollToLine(index: number, smooth: boolean) {
  // scrolls only the panel: scrollIntoView also scrolls every ancestor, including the document, which dragged
  // the whole now-playing page past the viewport whenever a line became active
  const container = scrollContainer.value;
  const el = lineRefs[index];
  if (!container || !el) return;
  const box = container.getBoundingClientRect();
  const line = el.getBoundingClientRect();
  const top = container.scrollTop + (line.top - box.top) - (box.height - line.height) / 2;
  container.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' });
}

// re-targets the intersection observer at whichever line is active; watching its visibility is
// what lets auto-scroll disable itself when the user scrolls away, and resume once they scroll back
function observeActive() {
  observer?.disconnect();
  const el = activeIndex.value >= 0 ? lineRefs[activeIndex.value] : null;
  if (!el || !scrollContainer.value) return;

  observer = new IntersectionObserver(
    (entries) => { autoScrollEnabled.value = entries[0]?.isIntersecting ?? false; },
    { root: scrollContainer.value, threshold: 0.6 }
  );
  observer.observe(el);
}

watch(activeIndex, async (index) => {
  if (index < 0) return;
  await nextTick();
  if (autoScrollEnabled.value) scrollToLine(index, true);
  observeActive();
});

async function loadLyrics(id: string | null) {
  observer?.disconnect();
  lineRefs = [];
  paragraphs.value = null;
  autoScrollEnabled.value = true;

  if (!id) return;

  const seq = ++requestSeq;
  const token = useAuthToken().token.value;
  if (!token) return;

  loading.value = true;
  try {
    const res = await $fetch<LyricsResponse>(`/api/v1/library/${id}/lyrics`, { headers: { Authorization: token }, timeout: 120_000 });
    if (seq !== requestSeq) return;
    paragraphs.value = res.paragraphs;
  } catch (e) {
    if (seq !== requestSeq) return;
    paragraphs.value = null;
    // a 404 is the normal "no lyrics for this track"; anything else (rate limit, provider down, timeout) is a failure worth saying
    if ((e as { statusCode?: number })?.statusCode !== 404) useToast().sendError(null, e);
  } finally {
    if (seq === requestSeq) loading.value = false;
  }

  await nextTick();
  if (scrollContainer.value) scrollContainer.value.scrollTop = 0;
  observeActive();
}

watch(() => currentTrack.value?.id ?? null, (id) => loadLyrics(id), { immediate: true });

watch(() => state.value.isPlaying, (playing) => { if (playing) startLoop(); else stopLoop(); });

onMounted(() => {
  syncTimeAnchor();
  if (state.value.isPlaying) startLoop();
});

onUnmounted(() => {
  observer?.disconnect();
  if (rafId !== null) cancelAnimationFrame(rafId);
  rafId = null;
});
</script>

<style scoped>
.lyrics-panel {
  overflow-y: auto;
  height: 100%;
  mask-image: linear-gradient(to bottom, transparent 0, #000 30px, #000 calc(100% - 30px), transparent 100%);
}

.lyrics-panel .status {
  color: color-mix(in srgb, var(--np-text, #ffffff) 90%, transparent);
  text-align: center;
  margin-top: 20px;
}

.lyrics-panel .static {
  white-space: pre-wrap;
  font-family: inherit;
  color: var(--np-text, #ffffff);
  line-height: 1.6;
  padding: 20px 4px;
}

.lyrics-panel .lines {
  list-style: none;
  padding: 20px 4px;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.lyrics-panel .lines li {
  /* the active line grows by transform, not font-size: no reflow, no re-wrapping of the lines around it, and it
     stays on the compositor. It scales from its left edge so the text doesn't drift sideways. */
  transform: scale(1);
  transform-origin: left center;
  /* --np-text is set by now-playing.vue from the cover (black on a light one, white on a dark one), so the
     lyrics follow the same WCAG-picked colour as the rest of the page instead of a hardcoded white */
  color: color-mix(in srgb, var(--np-text, #ffffff) 80%, transparent);
  font-size: 1.3em;
  font-weight: 600;
  line-height: 1.4;
  transition: color 0.35s ease, transform 0.35s ease;
  cursor: pointer;
  width: fit-content;
  max-width: 92%;
}

.lyrics-panel .lines li:hover {
  color: var(--np-text, #ffffff);
}

.lyrics-panel .lines li.gap {
  margin-top: 14px;
}

.lyrics-panel .lines li.bg {
  font-size: 1em;
  opacity: 0.8;
}

.lyrics-panel .lines li.active {
  color: var(--np-text, #ffffff);
  transform: scale(1.08);
  will-change: transform;
}

.lyrics-panel .lines li.bg.active {
  transform: scale(1.04);
}

@media (prefers-reduced-motion: reduce) {
  .lyrics-panel .lines li {
    transition: color 0.35s ease;
  }

  .lyrics-panel .lines li.active,
  .lyrics-panel .lines li.bg.active {
    transform: none;
  }
}

.lyrics-panel .segment {
  background-image: linear-gradient(90deg, var(--np-text, #ffffff) 50%, color-mix(in srgb, var(--np-text, #ffffff) 35%, transparent) 50%);
  background-size: 200% 100%;
  background-position-x: 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  transition: background-position-x 0.1s linear;
}

@media screen and (max-width: 800px) {
  .lyrics-panel .lines li {
    font-size: 1.05em;
  }

  .lyrics-panel .lines li.bg {
    font-size: 0.85em;
  }
}
</style>
