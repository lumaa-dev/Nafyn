<template>
  <div ref="scrollContainer" class="lyrics-panel">
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

interface LyricsResponse {
  provider: Provider;
  paragraphs: LyricParagraphs;
}

interface FlatLine extends LyricLine {
  firstInParagraph: boolean;
}

type LyricsKind = 'static' | 'paragraph' | 'beat';

const { currentTrack, state } = usePlayer();

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

function tick() {
  if (state.value.isPlaying) {
    displayedTime.value = anchorAudioTime + (performance.now() - anchorPerfTime) / 1000;
  }
  rafId = requestAnimationFrame(tick);
}

function clickLyric(line: LyricLine) {
  const { seek } = usePlayer();
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
const activeIndices = computed(() => {
  const time = displayedTime.value;
  const out: number[] = [];
  lines.value.forEach((line, i) => { if (time >= line.startTime && time < line.endTime) out.push(i); });
  return out;
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
  lineRefs[index]?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'center' });
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
  const token = useCookie('nafynToken').value;
  if (!token) return;

  loading.value = true;
  try {
    const res = await $fetch<LyricsResponse>(`/api/v1/library/${id}/lyrics`, { headers: { Authorization: token }, timeout: 120_000 });
    if (seq !== requestSeq) return;
    paragraphs.value = res.paragraphs;
  } catch {
    if (seq !== requestSeq) return;
    paragraphs.value = null;
  } finally {
    if (seq === requestSeq) loading.value = false;
  }

  await nextTick();
  if (scrollContainer.value) scrollContainer.value.scrollTop = 0;
  observeActive();
}

watch(() => currentTrack.value?.id ?? null, (id) => loadLyrics(id), { immediate: true });

onMounted(() => {
  syncTimeAnchor();
  rafId = requestAnimationFrame(tick);
});

onUnmounted(() => {
  observer?.disconnect();
  if (rafId !== null) cancelAnimationFrame(rafId);
});
</script>

<style scoped>
.lyrics-panel {
  overflow-y: auto;
  height: 100%;
  mask-image: linear-gradient(to bottom, transparent 0, #000 30px, #000 calc(100% - 30px), transparent 100%);
}

.lyrics-panel .status {
  color: #666666;
  text-align: center;
  margin-top: 20px;
}

.lyrics-panel .static {
  white-space: pre-wrap;
  font-family: inherit;
  color: #ffffffae;
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
  color: #666666;
  font-size: 1.3em;
  font-weight: 600;
  line-height: 1.4;
  transition: color 0.35s ease;
  cursor: pointer;
  width: fit-content;
}

.lyrics-panel .lines li:hover {
  color: #ffffff;
}

.lyrics-panel .lines li.gap {
  margin-top: 14px;
}

.lyrics-panel .lines li.bg {
  font-size: 1em;
  opacity: 0.8;
}

.lyrics-panel .lines li.active {
  color: #ffffff;
}

.lyrics-panel .segment {
  background-image: linear-gradient(90deg, #ffffff 50%, #ffffff4d 50%);
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
