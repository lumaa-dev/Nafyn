<template>
  <div class="year-package">
    <template v-if="yearly">
      <header class="head">
        <p class="kicker">{{ $t('insights.yearly.kicker') }}</p>
        <h1>{{ yearly.year }}</h1>
        <p v-if="yearly.snapshot" class="frozen">
          {{ $t('insights.yearly.frozen', { date: formatDate(yearly.snapshotCreatedAt) }) }}
        </p>
        <p v-else class="frozen">{{ $t('insights.yearly.live') }}</p>

        <div class="actions">
          <button type="button" filled :disabled="!reel || reel.slides.length === 0" @click="playReel">
            {{ $t('insights.reel.play') }}
          </button>
          <button type="button" filled="hollow" :disabled="sharing" @click="shareYear">
            {{ $t('insights.share.card') }}
          </button>
        </div>
      </header>

      <InsightsEnoughDataGate :gate="yearly.gate">
        <section class="subsection">
          <div class="tiles">
            <InsightsStatTile :label="$t('insights.stats.minutes')" :value="yearly.totals.totalMinutes.toLocaleString()" :spark="yearly.monthlyMinutes" />
            <InsightsStatTile :label="$t('insights.stats.plays')" :value="String(yearly.totals.totalPlays)" />
            <InsightsStatTile :label="$t('insights.stats.tracks')" :value="String(yearly.totals.uniqueTracks)" />
            <InsightsStatTile :label="$t('insights.stats.artists')" :value="String(yearly.totals.uniqueArtists)" />
            <InsightsStatTile :label="$t('insights.stats.albums')" :value="String(yearly.totals.uniqueAlbums)" />
            <InsightsStatTile :label="$t('insights.stats.streak')" :value="String(yearly.totals.longestStreakDays ?? 0)" />
          </div>
        </section>

        <section v-if="comparison.length > 1" class="subsection">
          <h2>{{ $t('insights.compare.title') }}</h2>
          <ChartsLineChart :series="comparisonSeries" :labels="monthLabels" :aria-label="$t('insights.compare.title')" />
          <ul class="compare-rows">
            <li v-for="row in comparison" :key="row.year">
              <span class="y">{{ row.year }}</span>
              <span>{{ $t('insights.metric.minutes', { count: row.totalMinutes }) }}</span>
              <span>{{ $t('insights.compare.artists', { count: row.uniqueArtists }) }}</span>
            </li>
          </ul>
        </section>

        <section class="subsection">
          <h2>{{ $t('insights.charts.byHour') }}</h2>
          <ChartsHourHistogram :points="yearly.hourHistogram" :aria-label="$t('insights.charts.byHour')" />
        </section>

        <section v-for="type in entityTypes" :key="type" class="subsection">
          <h2>{{ $t(`insights.top.${type}`) }}</h2>
          <InsightsTopEntityList
            v-if="fullLists[type].length"
            :entities="fullLists[type]"
            :metric="type === 'track' ? 'plays' : 'minutes'"
            show-cover
          />
          <p v-else class="empty">{{ $t('insights.empty') }}</p>
          <button
            v-if="hasMore[type]"
            type="button"
            filled="hollow"
            @click="loadMore(type)"
          >{{ $t('common.loadingMore') }}</button>
        </section>

        <section class="subsection">
          <h2>{{ $t('insights.reel.videoTitle') }}</h2>
          <p class="note">{{ $t('insights.reel.videoNote') }}</p>

          <video v-if="reel?.hasVideo" controls preload="metadata" :src="insights.reelVideoUrl(year)" class="reel-video" />

          <p v-if="reelStatus === 'queued' || reelStatus === 'rendering'" class="note">
            {{ $t(`insights.reel.status.${reelStatus}`) }}
          </p>
          <p v-else-if="reelStatus === 'failed'" class="error">{{ $t('insights.reel.status.failed') }}</p>

          <button
            v-if="reelStatus !== 'queued' && reelStatus !== 'rendering'"
            type="button"
            filled="hollow"
            :disabled="requestingVideo"
            @click="requestVideo"
          >
            {{ reel?.hasVideo ? $t('insights.reel.rerender') : $t('insights.reel.render') }}
          </button>
        </section>

        <NuxtLink :to="`/insights/replay/${year}`" class="mix-link">{{ $t('insights.replay.openYear', { year }) }}</NuxtLink>
      </InsightsEnoughDataGate>

      <InsightsReelPlayer ref="reelPlayer" :slides="reel?.slides ?? []" />
    </template>
  </div>
</template>

<script lang="ts" setup>
import { downloadShareCard } from '~/composables/useShareCard';
import type { RankedEntity } from '~/components/insights/TopEntityList.vue';
import type { EntityType, HighlightReel, YearComparison } from '~/composables/useInsights';

// The year-end package: the frozen snapshot if there is one, the live aggregates if not, plus the two
// shareable artefacts - the in-app reel and the optional downloadable MP4.
const year = Number(useRoute().params.year);
const insights = useInsights();

const entityTypes = ["track", "album", "artist", "playlist"] as const;
const monthLabels = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];
const PAGE_SIZE = 25;

const yearly = ref<Awaited<ReturnType<typeof insights.yearly>> | null>(null);
const comparison = ref<YearComparison[]>([]);
const reel = ref<HighlightReel | null>(null);
const reelPlayer = ref<{ start: () => void } | null>(null);
const requestingVideo = ref(false);
const sharing = ref(false);

const fullLists = reactive<Record<EntityType, RankedEntity[]>>({ track: [], album: [], artist: [], playlist: [] });
const hasMore = reactive<Record<EntityType, boolean>>({ track: false, album: false, artist: false, playlist: false });
const pages = reactive<Record<EntityType, number>>({ track: 0, album: 0, artist: 0, playlist: 0 });

const reelStatus = computed(() => reel.value?.reelStatus ?? "none");

const COMPARE_COLORS = ["#e18c46", "#4499cf", "#93c47d", "#cf44b8", "#cfc444"];
const comparisonSeries = computed(() => comparison.value.map((row, i) => ({
  name: String(row.year),
  color: COMPARE_COLORS[i % COMPARE_COLORS.length],
  points: row.monthlyMinutes,
  // everything except the year being viewed is drawn as context, not as the subject
  muted: row.year !== year
})));

function formatDate(ms: number | null): string {
  return ms ? new Date(ms).toLocaleDateString() : "";
}

async function loadMore(type: EntityType) {
  const page = pages[type] + 1;
  const result = await insights.top({ type, period: "year", year, page, limit: PAGE_SIZE });
  fullLists[type].push(...result.items);
  pages[type] = result.page;
  hasMore[type] = result.hasMore;
}

async function requestVideo() {
  requestingVideo.value = true;
  try {
    const result = await insights.requestReelVideo(year);
    if (reel.value) reel.value.reelStatus = result.reelStatus as HighlightReel["reelStatus"];
    // the render runs on the scheduler, so the page polls rather than waits
    pollReel();
  } catch {
    // the button re-enables; the reel section already shows whatever status the server last reported
  } finally {
    requestingVideo.value = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

function pollReel() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    try {
      reel.value = await insights.reel(year);
    } catch {
      // transient; the next tick tries again
      return;
    }
    if (reel.value.reelStatus !== "queued" && reel.value.reelStatus !== "rendering") {
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
    }
  }, 10_000);
}

function playReel() {
  reelPlayer.value?.start();
}

async function shareYear() {
  if (!yearly.value) return;
  sharing.value = true;

  try {
    await downloadShareCard({
      period: String(year),
      heading: $t('insights.share.heading'),
      listHeading: $t('insights.top.artist'),
      stats: [
        { label: $t('insights.stats.minutes'), value: yearly.value.totals.totalMinutes.toLocaleString() },
        { label: $t('insights.stats.artists'), value: String(yearly.value.totals.uniqueArtists) },
        { label: $t('insights.stats.tracks'), value: String(yearly.value.totals.uniqueTracks) },
        { label: $t('insights.stats.streak'), value: String(yearly.value.totals.longestStreakDays ?? 0) }
      ],
      list: yearly.value.top.artist.slice(0, 5).map((a) => ({ rank: a.rank, title: a.title ?? "?", subtitle: null })),
      footer: "Nafyn"
    }, `nafyn-${year}.png`);
  } finally {
    sharing.value = false;
  }
}

onMounted(async () => {
  yearly.value = await insights.yearly(year);

  // the reel manifest only exists once the year has been snapshotted, so a 404 here is an ordinary state
  reel.value = await insights.reel(year).catch(() => null);
  if (reelStatus.value === "queued" || reelStatus.value === "rendering") pollReel();

  comparison.value = await insights.compare().catch(() => []);

  await Promise.all(entityTypes.map((type) => loadMore(type)));
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style>
.year-package {
  margin: calc(15vh - 10px) auto;
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.year-package .head {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 10px;
}

.year-package .kicker {
  font-size: 0.75em;
  color: #e18c46;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.year-package h1 {
  font-family: "Discy";
  font-size: 3.5em;
  line-height: 1;
}

.year-package .frozen {
  font-size: 0.7em;
  color: #666666;
}

.year-package .actions {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 12px;
}

.year-package .subsection {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 0;
  border-top: 1px solid #ffffff1a;
}

.year-package .subsection h2 { font-size: 0.9em; }

.year-package .tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 10px;
}

.year-package .compare-rows {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  padding: 0;
  font-size: 0.75em;
  color: #999999;
}

.year-package .compare-rows li {
  display: flex;
  gap: 16px;
}

.year-package .compare-rows .y {
  font-family: "Discy";
  color: #ffffffae;
  width: 50px;
}

.year-package .reel-video {
  width: 100%;
  border-radius: 12px;
  background: #000;
}

.year-package .note { font-size: 0.75em; color: #666666; }
.year-package .error { font-size: 0.75em; color: #e06666; }
.year-package .empty { font-size: 0.8em; color: #666666; }
.year-package .mix-link { font-size: 0.85em; margin-top: 10px; }

@media screen and (max-width: 800px) {
  .year-package h1 { font-size: 2.5em; }
  .year-package .actions button { flex: 1 0 100%; }
}
</style>
