<template>
  <div class="insights">
    <nav class="insights-nav">
      <h2>{{ $t('insights.title') }}</h2>
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        :class="{ active: activeTab === tab.id }"
        @click="activeTab = tab.id"
      >
        {{ tab.label }}
      </button>
      <NuxtLink to="/insights/replay/current" class="mix-link">{{ $t('insights.replay.link') }}</NuxtLink>
    </nav>

    <section class="insights-content">
      <p v-if="!historyEnabled" class="notice">
        {{ $t('insights.disabled.body') }}
        <NuxtLink to="/settings">{{ $t('insights.disabled.link') }}</NuxtLink>
      </p>

      <!-- WEEKLY -->
      <div v-else-if="activeTab === 'weekly'" class="panel">
        <h1>{{ $t('insights.weekly.title') }}</h1>
        <p v-if="weekly" class="period">{{ weekly.week }}</p>

        <template v-if="weekly">
          <div class="tiles">
            <InsightsStatTile
              :label="$t('insights.stats.minutes')"
              :value="weekly.totals.totalMinutes.toLocaleString()"
              :delta="delta(weekly.totals.totalMinutes, weekly.previousTotals.totalMinutes)"
              :spark="weekly.series.map(p => p.minutes)"
            />
            <InsightsStatTile
              :label="$t('insights.stats.tracks')"
              :value="String(weekly.totals.uniqueTracks)"
              :delta="delta(weekly.totals.uniqueTracks, weekly.previousTotals.uniqueTracks)"
            />
            <InsightsStatTile
              :label="$t('insights.stats.artists')"
              :value="String(weekly.totals.uniqueArtists)"
              :delta="delta(weekly.totals.uniqueArtists, weekly.previousTotals.uniqueArtists)"
            />
          </div>

          <section class="subsection">
            <h2>{{ $t('insights.weekly.comparison') }}</h2>
            <ChartsLineChart
              :series="weekSeries"
              :labels="weekdayLabels"
              :aria-label="$t('insights.weekly.comparison')"
            />
          </section>

          <InsightsEnoughDataGate :gate="weekly.gate">
            <section v-for="type in entityTypes" :key="type" class="subsection">
              <h2>{{ $t(`insights.top.${type}`) }}</h2>
              <InsightsTopEntityList
                v-if="weekly.top[type].length"
                :entities="weekly.top[type].slice(0, 5)"
                :metric="type === 'track' ? 'plays' : 'minutes'"
                show-cover
              />
              <p v-else class="empty">{{ $t('insights.empty') }}</p>
            </section>
          </InsightsEnoughDataGate>
        </template>
      </div>

      <!-- MONTHLY -->
      <div v-else-if="activeTab === 'monthly'" class="panel">
        <h1>{{ $t('insights.monthly.title') }}</h1>
        <p v-if="monthly" class="period">{{ monthly.month }}</p>

        <template v-if="monthly">
          <div class="tiles">
            <InsightsStatTile
              :label="$t('insights.stats.minutes')"
              :value="monthly.totals.totalMinutes.toLocaleString()"
              :delta="delta(monthly.totals.totalMinutes, monthly.previousTotals.totalMinutes)"
              :spark="monthly.series.map(p => p.minutes)"
            />
            <InsightsStatTile :label="$t('insights.stats.plays')" :value="String(monthly.totals.totalPlays)" />
            <InsightsStatTile :label="$t('insights.stats.streak')" :value="String(monthly.totals.longestStreakDays ?? 0)" />
          </div>

          <InsightsEnoughDataGate :gate="monthly.gate">
            <section class="subsection">
              <h2>{{ $t('insights.top.artist') }}</h2>
              <ChartsBarChart :items="barItems(monthly.top.artist, 'minutes')" />
            </section>

            <section class="subsection">
              <h2>{{ $t('insights.top.track') }}</h2>
              <ChartsBarChart :items="barItems(monthly.top.track, 'plays')" />
            </section>

            <section class="subsection">
              <h2>{{ $t('insights.top.album') }}</h2>
              <ChartsBarChart :items="barItems(monthly.top.album, 'minutes')" />
            </section>

            <section class="subsection">
              <h2>{{ $t('insights.charts.byHour') }}</h2>
              <ChartsHourHistogram :points="monthly.hourHistogram" :aria-label="$t('insights.charts.byHour')" />
            </section>

            <button type="button" filled="hollow" :disabled="sharing" @click="shareMonth">
              {{ $t('insights.share.card') }}
            </button>
          </InsightsEnoughDataGate>
        </template>
      </div>

      <!-- YEARLY -->
      <div v-else class="panel">
        <h1>{{ $t('insights.yearly.title') }}</h1>

        <template v-if="yearly">
          <div class="year-switch">
            <button
              v-for="y in yearly.availableYears"
              :key="y"
              type="button"
              :class="{ active: y === selectedYear }"
              @click="selectYear(y)"
            >{{ y }}</button>
          </div>

          <div class="tiles">
            <InsightsStatTile
              :label="$t('insights.stats.minutes')"
              :value="yearly.totals.totalMinutes.toLocaleString()"
              :spark="yearly.monthlyMinutes"
            />
            <InsightsStatTile :label="$t('insights.stats.tracks')" :value="String(yearly.totals.uniqueTracks)" />
            <InsightsStatTile :label="$t('insights.stats.artists')" :value="String(yearly.totals.uniqueArtists)" />
            <InsightsStatTile :label="$t('insights.stats.albums')" :value="String(yearly.totals.uniqueAlbums)" />
            <InsightsStatTile :label="$t('insights.stats.streak')" :value="String(yearly.totals.longestStreakDays ?? 0)" />
          </div>

          <InsightsEnoughDataGate :gate="yearly.gate">
            <section class="subsection">
              <h2>{{ $t('insights.charts.byMonth') }}</h2>
              <ChartsLineChart
                :series="[{ name: String(selectedYear), color: '#e18c46', points: yearly.monthlyMinutes }]"
                :labels="monthLabels"
                :aria-label="$t('insights.charts.byMonth')"
              />
            </section>

            <section class="subsection">
              <h2>{{ $t('insights.charts.share') }}</h2>
              <ChartsDonutChart
                :slices="yearly.top.artist.slice(0, 8).map(a => ({ label: a.title ?? '?', value: a.minutes }))"
                :center-value="yearly.totals.totalMinutes.toLocaleString()"
                :center-label="$t('insights.stats.minutes')"
              />
            </section>

            <section v-for="type in entityTypes" :key="type" class="subsection">
              <h2>{{ $t(`insights.top.${type}`) }}</h2>
              <InsightsTopEntityList
                v-if="yearly.top[type].length"
                :entities="yearly.top[type].slice(0, 10)"
                :metric="type === 'track' ? 'plays' : 'minutes'"
                show-cover
              />
              <p v-else class="empty">{{ $t('insights.empty') }}</p>
            </section>

            <NuxtLink :to="`/insights/${selectedYear}`" class="package-link">
              {{ $t('insights.yearly.openPackage', { year: selectedYear }) }}
            </NuxtLink>
          </InsightsEnoughDataGate>
        </template>
      </div>
    </section>
  </div>
</template>

<script lang="ts" setup>
import { syncHistorySetting, useHistoryEnabled } from '~/composables/usePlayTracking';
import type { RankedEntity } from '~/components/insights/TopEntityList.vue';
import type { BarItem } from '~/components/charts/BarChart.vue';
import { downloadShareCard } from '~/composables/useShareCard';

// The insights hub. Mirrors settings.vue's shape - a sticky category nav plus one lazily-loaded panel -
// because these are the two "sections of a bigger thing" screens in the app and they should feel alike.
type TabId = "weekly" | "monthly" | "yearly";

const activeTab = ref<TabId>("weekly");
const entityTypes = ["track", "album", "artist", "playlist"] as const;

const insights = useInsights();
const historyEnabled = useHistoryEnabled();

const weekly = ref<Awaited<ReturnType<typeof insights.weekly>> | null>(null);
const monthly = ref<Awaited<ReturnType<typeof insights.monthly>> | null>(null);
const yearly = ref<Awaited<ReturnType<typeof insights.yearly>> | null>(null);
const selectedYear = ref<number>(new Date().getFullYear());
const sharing = ref(false);

const tabs = computed(() => ([
  { id: "weekly" as const, label: $t('insights.tabs.weekly') },
  { id: "monthly" as const, label: $t('insights.tabs.monthly') },
  { id: "yearly" as const, label: $t('insights.tabs.yearly') }
]));

const weekdayLabels = computed(() => weekly.value?.series.map((p) => p.date.slice(5)) ?? []);
const monthLabels = ["01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11", "12"];

// the previous week is drawn muted and dashed so the eye reads the solid line as "now"
const weekSeries = computed(() => weekly.value ? [
  { name: $t('insights.weekly.previous'), color: "#666666", points: weekly.value.previousSeries.map((p) => p.minutes), muted: true },
  { name: $t('insights.weekly.current'), color: "#e18c46", points: weekly.value.series.map((p) => p.minutes) }
] : []);

/** percentage change, or null when there is no previous period to compare against */
function delta(current: number, previous: number): number | null {
  if (!previous) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function barItems(entities: RankedEntity[], metric: "plays" | "minutes"): BarItem[] {
  return entities.slice(0, 8).map((e) => ({
    key: e.entityId,
    label: e.title ?? $t('insights.unknownEntity'),
    sublabel: e.subtitle,
    value: metric === "minutes" ? e.minutes : e.playCount,
    display: metric === "minutes"
      ? $t('insights.metric.minutes', { count: e.minutes })
      : $t('insights.metric.plays', { count: e.playCount })
  }));
}

async function loadWeekly() { weekly.value = await insights.weekly(); }
async function loadMonthly() { monthly.value = await insights.monthly(); }

async function loadYearly(year?: number) {
  yearly.value = await insights.yearly(year);
  selectedYear.value = yearly.value.year;
}

async function selectYear(year: number) {
  if (year === selectedYear.value) return;
  await loadYearly(year);
}

async function shareMonth() {
  if (!monthly.value) return;
  sharing.value = true;

  try {
    await downloadShareCard({
      period: monthly.value.month,
      heading: $t('insights.share.heading'),
      listHeading: $t('insights.top.track'),
      stats: [
        { label: $t('insights.stats.minutes'), value: monthly.value.totals.totalMinutes.toLocaleString() },
        { label: $t('insights.stats.plays'), value: String(monthly.value.totals.totalPlays) },
        { label: $t('insights.stats.artists'), value: String(monthly.value.totals.uniqueArtists) },
        { label: $t('insights.stats.tracks'), value: String(monthly.value.totals.uniqueTracks) }
      ],
      list: monthly.value.top.track.slice(0, 5).map((t) => ({
        rank: t.rank,
        title: t.title ?? "?",
        subtitle: t.subtitle
      })),
      footer: "Nafyn"
    }, `nafyn-${monthly.value.month}.png`);
  } finally {
    sharing.value = false;
  }
}

// panels load on first visit only, so switching tabs back and forth doesn't refetch
watch(activeTab, async (tab) => {
  if (tab === "weekly" && !weekly.value) await loadWeekly();
  if (tab === "monthly" && !monthly.value) await loadMonthly();
  if (tab === "yearly" && !yearly.value) await loadYearly();
});

onMounted(async () => {
  const enabled = await syncHistorySetting();
  if (enabled) await loadWeekly();
});
</script>

<style>
.insights {
  display: flex;
  gap: 60px;
  align-items: flex-start;
  margin: calc(15vh - 10px) auto;
  max-width: 900px;
}

.insights-nav {
  position: sticky;
  top: calc(15vh - 10px);
  display: flex;
  flex-direction: column;
  gap: 14px;
  width: 220px;
  flex-shrink: 0;
}

.insights-nav h2 {
  font-size: 1em;
  margin-bottom: 10px;
}

.insights-nav button {
  background: none;
  border: none;
  color: #ffffffae;
  text-align: left;
  font-family: "Instrument-Serif";
  font-size: 0.75em;
  padding: 8px 16px;
  border-radius: 250px;
}

.insights-nav button.active {
  background: #ffffffae;
  color: #000;
}

.insights-nav .mix-link {
  font-size: 0.75em;
  padding: 8px 16px;
}

.insights-content {
  flex: 1;
  max-width: 560px;
  min-width: 0;
}

.insights .panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
}

.insights .period {
  font-family: "Discy";
  font-size: 0.75em;
  color: #666666;
  margin-top: -12px;
}

.insights .tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 10px;
}

.insights .subsection {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 20px 0;
  border-top: 1px solid #ffffff1a;
}

.insights .subsection h2 {
  font-size: 0.9em;
}

.insights .empty,
.insights .notice {
  font-size: 0.8em;
  color: #666666;
}

.insights .year-switch {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.insights .year-switch button {
  background: none;
  border: 1px solid #ffffff1a;
  color: #ffffffae;
  font-family: "Discy";
  font-size: 0.7em;
  padding: 4px 12px;
  border-radius: 250px;
}

.insights .year-switch button.active {
  background: #e18c46;
  border-color: #e18c46;
  color: #000;
}

.insights .package-link {
  font-size: 0.85em;
  margin-top: 8px;
}

@media screen and (max-width: 800px) {
  .insights {
    flex-direction: column;
    align-items: stretch;
    gap: 30px;
  }

  .insights-nav {
    position: static;
    flex-direction: row;
    flex-wrap: nowrap;
    width: 100%;
    overflow-x: auto;
    padding-bottom: 4px;
    -webkit-overflow-scrolling: touch;
    align-items: center;
  }

  .insights-nav h2 { display: none; }
  .insights-nav button { flex-shrink: 0; }
  .insights-nav .mix-link { flex-shrink: 0; white-space: nowrap; }

  .insights-content {
    width: 100%;
    max-width: 100%;
  }
}
</style>
