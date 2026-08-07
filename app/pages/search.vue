<template>
  <div class="search" v-if="results">
    <h1>"{{ route.query.q }}"</h1>
    <span class="results" v-if="results.albums">
      <h2>{{ $t('search.albums') }}</h2>
      <div class="xs">
        <NuxtLink class="trad" :to="`/a/${alb.id}`" v-for="alb in results?.albums" :key="alb.id">
          <MediaBox :media="alb" />
        </NuxtLink>
      </div>
    </span>
    <span class="results" v-if="results.artists">
      <h2>{{ $t('search.artists') }}</h2>
      <div class="xs one">
        <ArtistBox v-for="art in results?.artists" :key="art.musicbrainzId" :artist="art" />
      </div>
    </span>
    <span class="results" v-if="results.tracks">
      <h2>{{ $t('search.tracks') }}</h2>
      <div class="xs">
        <NuxtLink class="trad" v-for="trk in results?.tracks" :key="trk.id" :to="`/t/${trk.id}`">
          <MediaBox :media="trk" />
        </NuxtLink>
      </div>
    </span>
  </div>
</template>

<script lang="ts" setup>
import MediaBox from '~/components/MediaBox.vue';
import ArtistBox from '~/components/ArtistBox.vue';
import type { ArtistInfo } from '~~/server/entity/media/ArtistInfo';
import type { MediaInfo } from '~~/server/entity/media/MediaInfo';

interface SearchResponse {
  albums: MediaInfo[],
  tracks: MediaInfo[],
  artists: ArtistInfo[]
}

const route = useRoute();
const token = useCookie("nafynToken").value;

// re-runs whenever `?q=` changes, so searching again while already on this page updates the results without a full page reload (which would kill audio playback)
const { data: results } = await useAsyncData<SearchResponse>("search", () => {
  const q = route.query.q;
  return token && typeof q === "string" && q.length > 0
    ? $fetch("/api/v1/search", { headers: { Authorization: token }, query: { q } })
    : Promise.resolve({ albums: [], tracks: [], artists: [] });
}, { default: () => {}, watch: [() => route.query.q] });
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
  min-width: calc(100vw - 1.2em * 2);
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