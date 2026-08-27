<template>
  <div class="replay">
    <template v-if="mix">
      <div class="head">
        <div class="cover" :style="coverStyle">
          <span v-if="!coverUrl">{{ mix.isAllTime ? '&#8734;' : mix.year }}</span>
        </div>

        <div class="meta">
          <p class="kicker">{{ $t('insights.replay.kicker') }}</p>
          <h1>{{ mix.isAllTime ? $t('insights.replay.allTime') : $t('insights.replay.yearTitle', { year: mix.year }) }}</h1>
          <p class="artist">{{ $t('insights.replay.subtitle', { count: playable.length }) }}</p>
          <p v-if="mix.refreshedAt" class="refreshed">{{ $t('insights.replay.refreshed', { date: formatDate(mix.refreshedAt) }) }}</p>
          <p class="locked">{{ $t('insights.replay.readOnly') }}</p>

          <div class="actions">
            <button type="button" filled :disabled="playable.length === 0" @click="playAll">{{ $t('playlist.play') }}</button>
            <button type="button" filled="hollow" :disabled="playable.length === 0" @click="shuffle">{{ $t('playlist.shuffle') }}</button>
          </div>
        </div>
      </div>

      <nav v-if="mix.archive.length > 1" class="archive">
        <NuxtLink
          v-for="entry in mix.archive"
          :key="entry.id"
          :to="`/insights/replay/${entry.year === 0 ? 'all-time' : entry.year}`"
          :class="{ active: entry.year === mix.year }"
        >
          {{ entry.year === 0 ? $t('insights.replay.allTime') : entry.year }}
        </NuxtLink>
      </nav>

      <ol v-if="mix.entries.length" class="tracks">
        <li
          v-for="entry in mix.entries"
          :key="entry.trackId"
          :class="{ playing: currentTrack?.id === entry.trackId, unavailable: !entry.available }"
        >
          <span class="pos">{{ entry.position + 1 }}</span>
          <img :src="entry.cover ?? noCover" alt="" @error="onCoverError">
          <span class="col">
            <span class="title">{{ entry.title ?? $t('insights.unknownEntity') }}</span>
            <span class="artist">{{ entry.subtitle ?? '' }}</span>
          </span>
          <span class="plays">{{ $t('insights.metric.plays', { count: entry.playCount }) }}</span>
          <button
            v-if="entry.available"
            type="button"
            class="play"
            :aria-label="$t('playlist.play')"
            @click="playFrom(entry)"
          >&#9654;</button>
          <span v-else class="gone">{{ $t('insights.replay.removed') }}</span>
        </li>
      </ol>

      <p v-else class="empty">{{ $t('insights.replay.empty') }}</p>
    </template>
  </div>
</template>

<script lang="ts" setup>
import noCover from '~/assets/no-cover.png';
import type { MediaRow } from '~~/server/core/library';
import type { ReplayEntry } from '~/composables/useInsights';

// The Replay Mix, presented as a playlist and deliberately offering nothing else.
//
// There is no rename, no reorder, no add, no remove and no delete anywhere on this page - not because they
// are hidden, but because the mix is not a playlist row and there is no endpoint that could serve them. The
// "read only" line below says so plainly rather than leaving the absence to be discovered.
const route = useRoute();
const insights = useInsights();
const { currentTrack, play } = usePlayer();

const mix = ref<Awaited<ReturnType<typeof insights.replay>> | null>(null);

// only entries the user still owns can go into the player queue
const playable = computed(() => (mix.value?.entries ?? []).filter((e) => e.media !== null));
const queue = computed<MediaRow[]>(() => playable.value.map((e) => e.media!));

const coverUrl = computed(() => playable.value.find((e) => e.cover)?.cover ?? null);
const coverStyle = computed(() => coverUrl.value ? { backgroundImage: `url(${coverUrl.value})` } : {});

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString();
}

function playFrom(entry: ReplayEntry) {
  if (!entry.media) return;
  play(entry.media, queue.value);
}

function playAll() {
  const first = queue.value[0];
  if (first) play(first, queue.value);
}

function shuffle() {
  const shuffled = [...queue.value];
  // Fisher-Yates; the mix itself is never reordered, only this playback queue
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
  }
  const first = shuffled[0];
  if (first) play(first, shuffled);
}

function onCoverError(e: Event) {
  (e.target as HTMLImageElement).src = noCover;
}

async function load() {
  const param = String(route.params.year);
  // "current" is the friendly URL the sidebar and hub link to, so nobody has to know the year
  mix.value = param === "current" ? await insights.replay() : await insights.replayYear(param === "all-time" ? "all-time" : Number(param));
}

await load();
watch(() => route.params.year, load);
</script>

<style>
.replay {
  margin: calc(15vh - 10px) auto;
  max-width: 900px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.replay .head {
  display: flex;
  gap: 30px;
  align-items: flex-end;
}

.replay .cover {
  width: 220px;
  height: 220px;
  border-radius: 14px;
  background-color: #00000040;
  background-size: cover;
  background-position: center;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: "Discy";
  font-size: 2em;
  color: #ffffff66;
}

.replay .meta {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.replay .kicker {
  font-size: 0.7em;
  color: #e18c46;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.replay h1 { font-size: 2.2em; }
.replay .artist { font-size: 0.85em; }
.replay .refreshed,
.replay .locked { font-size: 0.65em; color: #666666; }

.replay .actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}

.replay .archive {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.replay .archive a {
  font-family: "Discy";
  font-size: 0.7em;
  padding: 4px 12px;
  border-radius: 250px;
  border: 1px solid #ffffff1a;
  color: #ffffffae;
  text-decoration: none;
}

.replay .archive a.active {
  background: #e18c46;
  border-color: #e18c46;
  color: #000;
}

.replay .tracks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  padding: 0;
}

.replay .tracks li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 6px 10px;
  border-radius: 10px;
  min-width: 0;
}

.replay .tracks li.playing { background: #ffffff1a; }
.replay .tracks li.unavailable { opacity: 0.45; }

.replay .pos {
  font-family: "Discy";
  font-size: 0.7em;
  color: #666666;
  width: 26px;
  text-align: right;
  flex-shrink: 0;
}

.replay .tracks img {
  width: 45px;
  height: 45px;
  border-radius: 6px;
  object-fit: cover;
  background: #00000040;
  flex-shrink: 0;
}

.replay .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.replay .title,
.replay .tracks .artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.replay .title { font-size: 0.85em; }
.replay .tracks .artist { font-size: 0.65em; color: #666666; }

.replay .plays {
  font-family: "Discy";
  font-size: 0.7em;
  color: #666666;
  flex-shrink: 0;
}

.replay .play {
  background: none;
  border: none;
  color: #ffffffae;
  font-size: 0.8em;
  cursor: pointer;
  flex-shrink: 0;
}

.replay .gone {
  font-size: 0.6em;
  color: #666666;
  flex-shrink: 0;
}

.replay .empty { font-size: 0.8em; color: #666666; }

@media screen and (max-width: 800px) {
  .replay .head {
    flex-direction: column;
    align-items: stretch;
  }

  .replay .cover {
    width: 100%;
    height: auto;
    aspect-ratio: 1;
  }

  .replay .actions button { flex: 1; }
  .replay .plays { display: none; }
}
</style>
