<template>
  <div class="album" v-if="album">
    <div class="head">
      <img class="cover" :src="album.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" draggable="false" />
      <div class="meta">
        <span class="header">
          <h1>{{ album.title }}</h1>
          <p class="type" v-if="album.type">{{ album.type }}</p>
        </span>
        <p class="artist">{{ typeof album.artist == "string" ? album.artist : album.artist.name }}</p>
        <p class="description" v-if="album.description">{{ album.description }}</p>
        <button filled @click="requestMedia(album.id, 'album')">{{ $t('album.request') }}</button>
      </div>
    </div>

    <ol class="tracks">
      <h2>{{ $t('album.trackList') }}</h2>
      <li v-for="track in album.tracks" :key="track.id" :class="{ unreleased: !track.released }">
        <span class="number">{{ track.trackNumber }}</span>
        <span class="title">{{ track.title }}</span>
        <button filled="hollow" @click="requestTrack(track)" v-if="track.released && (!track.requested || !track.inLibrary)"><img src="../../assets/icons/download.svg" draggable="false"></button>
        <span class="duration" v-if="track.duration > 0">{{ formatDuration(track.duration) }}</span>
      </li>
    </ol>

    <p class="details">
      <span v-if="album.releaseDate">{{ formatDate(album.releaseDate) }}</span>
      <span v-if="album.label"> &middot; ℗ {{ album.label }}</span>
      <span> &middot; <a :href="`https://musicbrainz.org/release/${album.releaseId}`">{{ $t('album.viewInMusicbrainz') }}</a></span>
    </p>
  </div>
</template>

<script lang="ts" setup>
import type { AlbumDetail } from '~~/server/entity/media/AlbumDetail';
import type { TrackInfo } from '~~/server/entity/media/TrackInfo';
import noCover from '~/assets/no-cover.png';

const { locale } = useI18n();
const aid = useRoute().params.aid as string;
const token = useCookie("nafynToken").value;

const { data: album } = await useAsyncData<AlbumDetail>(`album-${aid}`, () => {
  return token
    ? $fetch(`/api/v1/album/${aid}`, { headers: { Authorization: token } })
    : Promise.reject(new Error("Not authenticated"));
});

function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString(locale.value, { year: "numeric", month: "long", day: "numeric" });
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

async function requestMedia(musicbrainzId: string, type: "album" | "track") {
  if (!token) return;
  await $fetch("/api/v1/request", {
    method: "POST",
    headers: { Authorization: token },
    body: { id: musicbrainzId, type }
  });
}

async function requestTrack(track: TrackInfo) {
  await requestMedia(track.id, "track");
  
  let i = album.value!.tracks.lastIndexOf(track);
  if (i > 0) {
    track.requested = true;
    album.value!.tracks[i] = track;
  }
}
</script>

<style scoped>
.album {
  max-width: 900px;
  margin: calc(15vh - 10px) auto;
}

.album .head {
  display: flex;
  flex-direction: row;
  gap: 30px;
  margin-bottom: 40px;
}

.album .head .header {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 20px;
}

.album .cover {
  width: 250px;
  height: 250px;
  aspect-ratio: 1 / 1;
  border-radius: 15px;
  background: #00000040;
}

.album .meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.album .meta button {
  margin: 1.2em 0;
}

.album .type {
  text-transform: uppercase;
  font-size: 1.0em;
  color: #ffffffae;
  border: #ffffffae 1px solid;
  border-radius: 250px;
  padding: 0.2em 1.0em;
}

.album .artist {
  font-family: "Instrument-Italic";
}

.album .details {
  font-size: 0.85em;
  color: #666666;
  margin: 1em 0;
}

.album .description {
  margin-top: 15px;
  font-size: 0.85em;
  color: #666666;
}

.album .tracks {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.album .tracks li {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 15px;
  padding: 10px 0;
}

.album .tracks li:not(:last-child) {
  border-bottom: 1px solid #666666;
}

.album .tracks li button {
  width: 2em;
  height: 2em;
  font-size: 0.8em;
  padding: 0;
}

.album .tracks li button img {
  transition: filter 0.15s ease-out;
  filter: invert();
  width: 1.2em;
  height: 1.2em;
  margin-top: 7px;
}

.album .tracks li button:hover img {
  filter: none;
}

.album .tracks .number {
  width: 1.5em;
  text-align: center;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  font-size: 0.85em;
}

.album .tracks li.unreleased .number {
  color: #666666;
}

.album .tracks .title {
  flex: 1;
}

.album .tracks .status {
  font-size: 0.75em;
  color: #666666;
  text-transform: uppercase;
}

.album .tracks .duration {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  font-size: 0.7em;
}

.album .tracks li.unreleased .title {
  color: #666666;
}

@media screen and (max-width: 800px) {
  .album {
    margin: calc(15vh - 10px) 1.2em;
  }

  .album .type {
    font-size: 0.75em;
  }

  .album .head {
    flex-direction: column;
  }

  .album .head .header {
    flex-direction: column-reverse;
    align-items: start;
    gap: 0;
  }

  .album .head .cover {
    margin: 0 auto;
  }

  .album .tracks li {
    margin: 0 -1.2em;
    padding: 10px 0.7em;
  }
}
</style>
