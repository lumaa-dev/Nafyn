<template>
  <div class="search">
    <!-- <h1>"{{ route.query.q }}"</h1> -->
    <p v-if="searching" class="status" role="status">{{ $t('search.loading') }}</p>

    <!-- the search engine's confident top match: above everything, other services included -->
    <span class="results best" v-if="best">
      <h2>{{ $t('search.best') }}</h2>
      <div class="xs one">
        <NuxtLink class="trad" :to="best.type === 'track' ? `/t/${best.id}` : `/a/${best.id}`">
          <MediaBox :media="best" />
        </NuxtLink>
      </div>
    </span>
    <span class="results" v-if="metadata?.results.length">
      <h2>{{ $t('search.metadata') }}</h2>
      <div class="xs one">
        <button type="button" class="trad metabutton" v-for="meta in metadata.results" :key="meta.ref" :class="{ resolving: resolving.has(meta.ref) }" :disabled="resolving.has(meta.ref)" @click="openMetadata(meta)">
          <MetadataBox :metadata="meta" />
        </button>
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
        <NuxtLink class="trad" :to="`/ar/${art.musicbrainzId}`" v-for="art in results.artists" :key="art.musicbrainzId">
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
import MetadataBox from '~/components/MetadataBox.vue';
import { isStructuredMetadataQuery } from '~~/server/utils/metadata/query';
import type { MetadataLookupResult, SongMetadata } from '~~/server/utils/metadata/types';
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
  // an ISRC, platform ID or link means nothing to MusicBrainz' text search - the metadata lookup below
  // resolves those to a MusicBrainz recording itself
  return token.value && typeof q === "string" && q.length > 0 && !isStructuredMetadataQuery(q)
    ? $fetch<SearchResponse>("/api/v1/search", { headers: { Authorization: token.value }, query: { q } })
    : Promise.resolve(emptyResponse());
}, { server: false, default: emptyResponse, watch: [() => route.query.q] });
useLoadErrorToast(searchError);

// other services (Deezer, iTunes, ...) are slower and optional, so they load client-side after the
// MusicBrainz results rather than holding the page up
const { data: metadata, status: metadataStatus } = useLazyAsyncData<MetadataLookupResult | null>("search-metadata", () => {
  const q = route.query.q;
  return token.value && typeof q === "string" && q.length > 0
    ? $fetch<MetadataLookupResult>("/api/v1/metadata/search", { headers: { Authorization: token.value }, query: { q } }).catch(() => null)
    : Promise.resolve(null);
}, { server: false, default: () => null, watch: [() => route.query.q] });

const searching = computed(() => searchStatus.value === "pending" || metadataStatus.value === "pending");

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
  && !best.value && !albums.value.length && !tracks.value.length && !results.value.artists.length && !metadata.value?.results.length
);

// refs currently being resolved (POST /api/v1/metadata/resolve), so a second click on the same card while
// it's in flight is a no-op rather than firing another lookup
const resolving = ref<Set<string>>(new Set());

// a record ISRC/ID lookups already resolved (server/utils/metadata/index.ts) opens straight on its
// MusicBrainz track/album; everything else (a text-search hit, or an enrichment record of a different kind
// than the one that was looked up) is resolved on demand by its `ref` when actually clicked
async function openMetadata(meta: SongMetadata) {
  if (meta.musicbrainzId) {
    navigateTo(meta.kind === "album" ? `/a/${meta.musicbrainzId}` : `/t/${meta.musicbrainzId}`);
    return;
  }
  if (resolving.value.has(meta.ref) || !token.value) return;

  resolving.value.add(meta.ref);
  try {
    const resolved = await $fetch<{ kind: "track" | "album", musicbrainzId: string }>("/api/v1/metadata/resolve", { headers: { Authorization: token.value }, query: { ref: meta.ref } });
    navigateTo(resolved.kind === "album" ? `/a/${resolved.musicbrainzId}` : `/t/${resolved.musicbrainzId}`);
  } catch (e) {
    // no MusicBrainz match - fall back to the provider's own page when it has one
    if (meta.url) window.open(meta.url, "_blank", "noopener,noreferrer");
    else useToast().sendError(meta.title, e, $t('search.notFound'));
  } finally {
    resolving.value.delete(meta.ref);
  }
}

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

.metabutton {
  background: none;
  border: none;
  padding: 0;
  text-align: left;
  cursor: pointer;
  color: inherit;
}

.metabutton.resolving {
  opacity: 0.6;
  cursor: default;
}
</style>