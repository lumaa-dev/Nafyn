<template>
  <div class="libtracks">
    <h1>{{ $t('library.tracks.title') }}</h1>
    <ol class="tracks" v-if="tracks.length > 0">
      <li v-for="track in tracks" :key="track.id" :class="{ playing: currentTrack?.id === track.id }" @click="play(track, tracks)">
        <img :src="track.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" />
        <span class="col">
          <span class="title">{{ track.title }}</span>
          <span class="artist">{{ track.artistName }}</span>
        </span>
        <NuxtLink v-if="track.album" :to="`/t/${track.musicbrainzId}`" class="album" @click.stop>{{ track.album }}</NuxtLink>
        <span class="duration">{{ formatDuration(track.duration) }}</span>
      </li>
    </ol>
    <p class="empty" v-else>{{ $t('library.tracks.empty') }}</p>
  </div>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import noCover from '~/assets/no-cover.png';

const token = useCookie("nafynToken").value;

const { data: tracks } = await useAsyncData<MediaRow[]>("library-tracks", () => {
  return token
    ? $fetch("/api/v1/library/tracks", { headers: { Authorization: token } })
    : Promise.resolve([]);
}, { default: () => [] });

const { currentTrack, play } = usePlayer();

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}
</script>

<style>
.libtracks {
  max-width: 900px;
  margin: calc(15vh - 10px) auto;
}

.libtracks .empty {
  color: #666666;
}

.libtracks .tracks {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.libtracks .tracks li {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 15px;
  padding: 10px 0;
  cursor: pointer;
}

.libtracks .tracks li.playing .title {
  color: #ffffff;
  font-weight: 700;
}

.libtracks .tracks li:not(:last-child) {
  border-bottom: 1px solid #666666;
}

.libtracks .tracks img {
  width: 45px;
  height: 45px;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  background: #00000040;
}

.libtracks .tracks .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.libtracks .tracks .title, .libtracks .tracks .album {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.libtracks .tracks .artist {
  font-size: 0.85em;
  color: #666666;
}

.libtracks .tracks .album {
  max-width: 200px;
  font-size: 0.85em;
  color: #666666;
}

.libtracks .tracks .duration {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  font-size: 0.7em;
}

@media screen and (max-width: 800px) {
  .libtracks {
    margin: calc(15vh - 10px) 1.2em;
  }

  .libtracks .tracks .album {
    display: none;
  }

  .libtracks .tracks li {
    margin: 0 -1.2em;
    padding: 10px 1.2em;
  }
}
</style>
