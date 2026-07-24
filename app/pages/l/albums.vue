<template>
  <div class="libalbums">
    <h1>{{ $t('library.albums.title') }}</h1>
    <div class="grid" v-if="albums.length > 0">
      <NuxtLink v-for="album in albums" :key="album.id" :to="`/t/${album.mbId}`">
        <MediaBox :media="toMediaInfo(album)" />
      </NuxtLink>
    </div>
    <p class="empty" v-else>{{ $t('library.albums.empty') }}</p>
  </div>
</template>

<script lang="ts" setup>
import MediaBox from '~/components/MediaBox.vue';
import type { AlbumRow } from '~~/server/core/library';
import type { MediaInfo } from '~~/server/entity/media/MediaInfo';

const { t } = useI18n();
const token = useCookie("discyToken").value;

const { data: albums } = await useAsyncData<AlbumRow[]>("library-albums", () => {
  return token
    ? $fetch("/api/v1/library/albums", { headers: { Authorization: token } })
    : Promise.resolve([]);
}, { default: () => [] });

function toMediaInfo(album: AlbumRow): MediaInfo {
  return {
    id: album.mbId,
    title: album.title ?? t("common.unknownAlbum"),
    artist: album.artistName,
    album: null,
    type: null,
    coverArt: album.coverArt,
    releaseDate: album.releaseDate ? new Date(album.releaseDate * 1000) : null,
    inLibrary: true,
    duration: album.duration,
    label: null
  };
}
</script>

<style>
.libalbums {
  max-width: 1200px;
  margin: calc(15vh - 10px) auto;
}

.libalbums .empty {
  color: #666666;
}

.libalbums .grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 20px;
}

@media screen and (max-width: 800px) {
  .libalbums {
    margin: calc(15vh - 10px) 1.2em;
  }
}
</style>
