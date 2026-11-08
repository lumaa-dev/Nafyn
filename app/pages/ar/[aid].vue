<template>
  <div class="artist" v-if="artist">
    <div class="head">
      <CoverImage class="cover" :src="artist.image" eager />
      <div class="meta">
        <h1>{{ artist.name }}</h1>
        <p class="listeners" v-if="artist.listeners">{{ $t('artist.listeners', { count: artist.listeners.toLocaleString() }) }}</p>
        <p class="bio" v-if="artist.bio">{{ artist.bio }}</p>
      </div>
    </div>

    <!-- the discography by kind: Albums, EPs, Singles... newest first, each a grid that scrolls sideways -->
    <template v-if="artist.categories.length > 0">
      <ReleaseGrid v-for="category in artist.categories" :key="category.id" :title="$t(`artist.category.${category.id}`)">
        <NuxtLink v-for="rel in category.releases" :key="`${rel.id}-${rel.releaseId ?? ''}`" :to="releaseLink(rel)">
          <MediaBox :media="rel" />
        </NuxtLink>
      </ReleaseGrid>
    </template>

    <p class="details">
      <a :href="`https://musicbrainz.org/artist/${artist.id}`">{{ $t('artist.viewInMusicbrainz') }}</a>
    </p>
  </div>
  <LoadError v-else :error="error" />
</template>

<script lang="ts" setup>
import type { ArtistDetail, ArtistRelease } from '~~/server/entity/media/ArtistDetail';
import MediaBox from '~/components/MediaBox.vue';
import ReleaseGrid from '~/components/ReleaseGrid.vue';
import { useAuthToken } from '~/composables/useAuthToken';

const aid = useRoute().params.aid as string;
const { token } = useAuthToken();

const { data: artist, error } = await useAsyncData<ArtistDetail>(`artist-${aid}`, () => {
  return token.value
    ? $fetch(`/api/v1/artist/${aid}`, { headers: { Authorization: token.value } })
    : Promise.reject(new Error("Not authenticated"));
});

// an edition (Deluxe, Remaster) opens its album on that release
function releaseLink(release: ArtistRelease): string {
  return release.releaseId ? `/a/${release.id}?release=${release.releaseId}` : `/a/${release.id}`;
}
</script>

<style scoped>
.artist {
  max-width: 1200px;
}

.artist .head {
  display: flex;
  flex-direction: row;
  gap: 30px;
  margin-bottom: 40px;
}

.artist .cover {
  width: 220px;
  height: 220px;
  aspect-ratio: 1 / 1;
  border-radius: 50%;
  object-fit: cover;
  background: #00000040;
  flex-shrink: 0;
}

.artist .meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.artist .listeners {
  font-size: 0.8em;
  color: var(--tint-fg, #ffffffae);
  margin-top: 4px;
}

.artist .bio {
  margin-top: 15px;
  font-size: 0.85em;
  color: var(--tint-fg, #ffffffae);
  white-space: pre-line;
}

.artist .details {
  font-size: 0.85em;
  color: var(--tint-fg, #ffffffae);
  margin: 20px 0;
}

@media screen and (max-width: 800px) {

  .artist .head {
    flex-direction: column;
  }

  .artist .cover {
    margin: 0 auto;
  }
}
</style>
