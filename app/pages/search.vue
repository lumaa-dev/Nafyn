<template>
  <div class="search">
    <p v-if="searching" class="status" role="status">{{ $t('search.loading') }}</p>
    <LoadError :error="searchError" />

    <!-- one list: the most likely answer at the top, the least likely at the bottom -->
    <ol class="list" v-if="entries.length">
      <li v-for="entry in entries" :key="entryKey(entry)">
        <SearchRow :entry="entry" />
      </li>
    </ol>
    <p v-if="nothingFound" class="status">{{ $t('search.empty') }}</p>
  </div>
</template>

<script lang="ts" setup>
import SearchRow from '~/components/SearchRow.vue';
import type { ArtistInfo } from '~~/server/entity/media/ArtistInfo';
import type { MediaInfo } from '~~/server/entity/media/MediaInfo';
import type { SearchEntry } from '~~/server/entity/media/SearchEntry';
import { useAuthToken } from '~/composables/useAuthToken';

interface SearchResponse {
  results: SearchEntry[],
  albums: MediaInfo[],
  tracks: MediaInfo[],
  artists: ArtistInfo[]
}

const emptyResponse = (): SearchResponse => ({ results: [], albums: [], tracks: [], artists: [] });

const route = useRoute();
const { token } = useAuthToken();

// Fetched client-side and never awaited. The engine behind this endpoint ranks, filters and checks cover art, which
// takes seconds: awaiting it blocked the route change itself, so pressing enter in the header seemed to do
// nothing (or showed a blank page when it failed). The page now renders at once, says it is searching, and
// fills in as results arrive. Re-runs whenever `?q=` changes, so searching again while already on this page
// updates it without a full page reload (which would kill audio playback).
const { data: results, status: searchStatus, error: searchError } = useLazyAsyncData<SearchResponse>("search", () => {
  const q = route.query.q;
  return token.value && typeof q === "string" && q.length > 0
    ? $fetch<SearchResponse>("/api/v1/search", { headers: { Authorization: token.value }, query: { q } })
    : Promise.resolve(emptyResponse());
}, { server: false, default: emptyResponse, watch: [() => route.query.q] });

// Artist pictures are not part of the search response (finding one can take three upstream calls): the ones the
// server already knew come with it, the others are fetched here a few at a time and fill in as they arrive.
// Background traffic nobody asked for by name, so a failure stays silent and the artist keeps the placeholder.
const MAX_PICTURE_REQUESTS = 3;
const artistImages = ref<Record<string, string>>({});
const requestedPictures = new Set<string>();
let pictureRun = 0;

// the list as the server ranked it, with the pictures that arrived since
const entries = computed<SearchEntry[]>(() =>
  results.value.results.map((entry) => entry.kind === "artist" && entry.artist
    ? { ...entry, artist: { ...entry.artist, image: entry.artist.image ?? artistImages.value[entry.artist.musicbrainzId] ?? null } }
    : entry)
);

function entryKey(entry: SearchEntry): string {
  return `${entry.kind}-${entry.kind === "artist" ? entry.artist?.musicbrainzId : entry.media?.id}`;
}

async function fetchArtistPictures(list: ArtistInfo[]) {
  if (!token.value) return;
  const run = ++pictureRun;
  const queue = list.filter((artist) => artist.musicbrainzId && !artist.image && !requestedPictures.has(artist.musicbrainzId));
  const worker = async () => {
    for (let artist = queue.shift(); artist; artist = queue.shift()) {
      if (run !== pictureRun) return;
      requestedPictures.add(artist.musicbrainzId);
      try {
        const { image } = await $fetch<{ image: string | null }>(`/api/v1/artist/${artist.musicbrainzId}/image`, { headers: { Authorization: token.value! } });
        if (image) artistImages.value = { ...artistImages.value, [artist.musicbrainzId]: image };
      } catch {
        // allowed to try again on the next search
        requestedPictures.delete(artist.musicbrainzId);
      }
    }
  };
  await Promise.all(Array.from({ length: MAX_PICTURE_REQUESTS }, worker));
}

watch(() => results.value.results, (list) => {
  void fetchArtistPictures(list.flatMap((entry) => entry.kind === "artist" && entry.artist ? [entry.artist] : []));
}, { immediate: true });

const searching = computed(() => searchStatus.value === "pending");

// not while loading, and not after a failure (that one already has its toast)
const nothingFound = computed(() => !searching.value && !searchError.value && !!route.query.q && entries.value.length === 0);
</script>

<style>
/* `.view` leaves the first ~10px of the Header's gradient band uncovered: the list starts below it */
.search {
  max-width: 900px;
  padding-top: 40px;
}

.search .list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
}

.search .list li {
  min-width: 0;
}

.search .list li:not(:last-child) {
  border-bottom: 1px solid #666666;
}

.search .status {
  color: var(--tint-fg, #ffffffae);
}
</style>
