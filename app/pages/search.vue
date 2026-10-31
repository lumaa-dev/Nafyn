<template>
  <div class="search">
    <!-- <h1>"{{ route.query.q }}"</h1> -->
    <p v-if="searching" class="status" role="status">{{ $t('search.loading') }}</p>

    <!-- the search engine's confident top match: above everything -->
    <span class="results best" v-if="best">
      <h2>{{ $t('search.best') }}</h2>
      <div class="xs one">
        <NuxtLink class="trad" :to="best.type === 'track' ? `/t/${best.id}` : `/a/${best.id}`">
          <MediaBox :media="best" />
        </NuxtLink>
      </div>
    </span>
    <span class="results" v-if="albums.length">
      <h2>{{ $t('search.albums') }}</h2>
      <div class="xs">
        <NuxtLink class="trad" :to="`/a/${alb.id}`" v-for="alb in albums" :key="alb.id">
          <MediaBox :media="alb" />
        </NuxtLink>
      </div>
    </span>
    <span class="results" v-if="results.artists?.length">
      <h2>{{ $t('search.artists') }}</h2>
      <div class="xs one">
        <NuxtLink class="trad" :to="`/ar/${art.musicbrainzId}`" v-for="art in artists" :key="art.musicbrainzId">
          <ArtistBox :artist="art" />
        </NuxtLink>
      </div>
    </span>
    <span class="results" v-if="tracks.length">
      <h2>{{ $t('search.tracks') }}</h2>
      <div class="xs">
        <NuxtLink class="trad" v-for="trk in tracks" :key="trk.id" :to="`/t/${trk.id}`">
          <MediaBox :media="trk" />
        </NuxtLink>
      </div>
    </span>
    <p v-if="nothingFound" class="status">{{ $t('search.empty') }}</p>
  </div>
</template>

<script lang="ts" setup>
import MediaBox from '~/components/MediaBox.vue';
import ArtistBox from '~/components/ArtistBox.vue';
import type { ArtistInfo } from '~~/server/entity/media/ArtistInfo';
import type { MediaInfo } from '~~/server/entity/media/MediaInfo';
import { useAuthToken } from '~/composables/useAuthToken';

interface SearchResponse {
  albums: MediaInfo[],
  tracks: MediaInfo[],
  artists: ArtistInfo[]
}

const emptyResponse = (): SearchResponse => ({ albums: [], tracks: [], artists: [] });

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
useLoadErrorToast(searchError);

// Artist pictures are not part of the search response (finding one can take three upstream calls): the ones the
// server already knew come with it, the others are fetched here a few at a time and fill in as they arrive.
// Background traffic nobody asked for by name, so a failure stays silent and the artist keeps the placeholder.
const MAX_PICTURE_REQUESTS = 3;
const artistImages = ref<Record<string, string>>({});
const requestedPictures = new Set<string>();
let pictureRun = 0;

const artists = computed<ArtistInfo[]>(() =>
  results.value.artists.map((artist) => ({ ...artist, image: artist.image ?? artistImages.value[artist.musicbrainzId] ?? null }))
);

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

watch(() => results.value.artists, (list) => { void fetchArtistPictures(list); }, { immediate: true });

const searching = computed(() => searchStatus.value === "pending");

// The engine flags at most one album and one track as `bestResult`. When both are, the more relevant one wins,
// and it is lifted out of its list so it isn't shown twice.
const best = computed<MediaInfo | null>(() => {
  const flagged = [...results.value.albums, ...results.value.tracks].filter((media) => media.bestResult);
  return flagged.sort((a, b) => (b.match?.relevance ?? 0) - (a.match?.relevance ?? 0))[0] ?? null;
});
const albums = computed(() => results.value.albums.filter((media) => media !== best.value));
const tracks = computed(() => results.value.tracks.filter((media) => media !== best.value));

// not while loading, and not after a failure (that one already has its toast)
const nothingFound = computed(() =>
  !searching.value && !searchError.value && !!route.query.q
  && !best.value && !albums.value.length && !tracks.value.length && !results.value.artists.length
);
</script>

<style>
.search h1 {
  width: 100%;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.results {
  margin: 2.5em;
}

.search .status {
  margin: 2.5em;
}

.xs::-webkit-scrollbar {
  display: none;
}

.xs {
  margin: 0 -1.2em;
  padding: 0 1.2em;
  display: grid;
  grid-auto-flow: column;
  grid-template-rows: repeat(2, calc(230px + 2em));
  gap: 20px;
  min-width: calc(100vw - 220px - 1.2em * 2);
  overflow: scroll hidden;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.one {
  grid-template-rows: repeat(1, calc(230px + 2em));
}

.trad {
  font-family: "Instrument-Serif";
  text-decoration: none;
}
</style>
