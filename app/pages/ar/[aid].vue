<template>
  <div class="artist" v-if="artist">
    <div class="head">
      <img class="cover" :src="artist.image ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" draggable="false" />
      <div class="meta">
        <h1>{{ artist.name }}</h1>
        <p class="listeners" v-if="artist.listeners">{{ $t('artist.listeners', { count: artist.listeners.toLocaleString() }) }}</p>
        <p class="bio" v-if="artist.bio">{{ artist.bio }}</p>
      </div>
    </div>

    <template v-if="artist.albums.length > 0">
      <h2>{{ $t('artist.discography') }}</h2>
      <div class="grid">
        <NuxtLink class="trad" :to="`/a/${alb.id}`" v-for="alb in artist.albums" :key="alb.id">
          <MediaBox :media="alb" />
        </NuxtLink>
      </div>
    </template>

    <p class="details">
      <a :href="`https://musicbrainz.org/artist/${artist.id}`">{{ $t('artist.viewInMusicbrainz') }}</a>
    </p>
  </div>
</template>

<script lang="ts" setup>
import type { ArtistDetail } from '~~/server/entity/media/ArtistDetail';
import noCover from '~/assets/no-cover.png';
import MediaBox from '~/components/MediaBox.vue';

const aid = useRoute().params.aid as string;
const token = useCookie("nafynToken").value;

const { data: artist } = await useAsyncData<ArtistDetail>(`artist-${aid}`, () => {
  return token
    ? $fetch(`/api/v1/artist/${aid}`, { headers: { Authorization: token } })
    : Promise.reject(new Error("Not authenticated"));
});
</script>

<style scoped>
.artist {
  max-width: 900px;
  margin: calc(15vh - 10px) auto;
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
  color: #666666;
  margin-top: 4px;
}

.artist .bio {
  margin-top: 15px;
  font-size: 0.85em;
  color: #999999;
  white-space: pre-line;
}

.artist h2 {
  margin-bottom: 20px;
}

.artist .grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 20px;
}

.artist .trad {
  font-family: "Instrument-Serif";
  text-decoration: none;
}

.artist .details {
  font-size: 0.85em;
  color: #666666;
  margin: 20px 0;
}

@media screen and (max-width: 800px) {
  .artist {
    margin: calc(15vh - 10px) 1.2em;
  }

  .artist .head {
    flex-direction: column;
  }

  .artist .cover {
    margin: 0 auto;
  }
}
</style>
