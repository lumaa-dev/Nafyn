<template>
  <div class="search" v-if="results">
    <!-- <h1>"{{ route.query.q }}"</h1> -->
    <span class="results" v-if="metadata?.results.length">
      <h2>{{ $t('search.metadata') }}</h2>
      <div class="xs one">
        <button type="button" class="trad metabutton" v-for="meta in metadata.results" :key="meta.ref" :class="{ resolving: resolving.has(meta.ref) }" :disabled="resolving.has(meta.ref)" @click="openMetadata(meta)">
          <MetadataBox :metadata="meta" />
        </button>
      </div>
    </span>
    <span class="results" v-if="results.albums?.length">
      <h2>{{ $t('search.albums') }}</h2>
      <div class="xs">
        <NuxtLink class="trad" :to="`/a/${alb.id}`" v-for="alb in results?.albums" :key="alb.id">
          <MediaBox :media="alb" />
        </NuxtLink>
      </div>
    </span>
    <span class="results" v-if="results.artists?.length">
      <h2>{{ $t('search.artists') }}</h2>
      <div class="xs one">
        <NuxtLink class="trad" :to="`/ar/${art.musicbrainzId}`" v-for="art in results?.artists" :key="art.musicbrainzId">
          <ArtistBox :artist="art" />
        </NuxtLink>
      </div>
    </span>
    <span class="results" v-if="results.tracks?.length">
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
import MetadataBox from '~/components/MetadataBox.vue';
import { isStructuredMetadataQuery } from '~~/server/utils/metadata/query';
import type { MetadataLookupResult, SongMetadata } from '~~/server/utils/metadata/types';
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
  // an ISRC, platform ID or link means nothing to MusicBrainz' text search - the metadata lookup below
  // resolves those to a MusicBrainz recording itself
  return token && typeof q === "string" && q.length > 0 && !isStructuredMetadataQuery(q)
    ? $fetch("/api/v1/search", { headers: { Authorization: token }, query: { q } })
    : Promise.resolve({ albums: [], tracks: [], artists: [] });
}, { default: () => {}, watch: [() => route.query.q] });

// other services (Deezer, iTunes, ...) are slower and optional, so they load client-side after the
// MusicBrainz results rather than holding the page up
const { data: metadata } = useLazyAsyncData<MetadataLookupResult | null>("search-metadata", () => {
  const q = route.query.q;
  return token && typeof q === "string" && q.length > 0
    ? $fetch<MetadataLookupResult>("/api/v1/metadata/search", { headers: { Authorization: token }, query: { q } }).catch(() => null)
    : Promise.resolve(null);
}, { server: false, default: () => null, watch: [() => route.query.q] });

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
  if (resolving.value.has(meta.ref) || !token) return;

  resolving.value.add(meta.ref);
  try {
    const resolved = await $fetch<{ kind: "track" | "album", musicbrainzId: string }>("/api/v1/metadata/resolve", { headers: { Authorization: token }, query: { ref: meta.ref } });
    navigateTo(resolved.kind === "album" ? `/a/${resolved.musicbrainzId}` : `/t/${resolved.musicbrainzId}`);
  } catch {
    // no MusicBrainz match - fall back to the provider's own page when it has one
    if (meta.url) window.open(meta.url, "_blank", "noopener,noreferrer");
    else sendToast(meta.title, $t('search.notFound'), false);
  } finally {
    resolving.value.delete(meta.ref);
  }
}

function sendToast(title: string | null, message: string, success: boolean = true) {
  useToast().sendToast({ content: message, tint: success ? "green" : "red", icon: null, title });
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