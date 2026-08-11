<template>
  <div class="track" v-if="track">
    <div class="head">
      <img class="cover" :src="track.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" draggable="false" />
      <div class="meta">
        <span class="header">
          <h1>{{ track.title }}</h1>
        </span>
        <p class="artist">{{ typeof track.artist == "string" ? track.artist : track.artist.name }}</p>
        <NuxtLink class="album-link" v-if="track.album?.id" :to="`/a/${track.album.id}`">
          {{ track.album.title }}
        </NuxtLink>
        <button filled @click="requestMedia(track.id, 'track', track.title)" v-if="!track.inLibrary">{{ $t('track.request') }}</button>
      </div>
    </div>

    <p class="details">
      <span v-if="track.duration > 0">{{ formatDuration(track.duration) }}</span>
      <span v-if="track.releaseDate"> &middot; {{ formatDate(track.releaseDate) }}</span>
      <span v-if="track.label"> &middot; ℗ {{ track.label }}</span>
      <span> &middot; <a :href="`https://musicbrainz.org/recording/${track.id}`">{{ $t('track.viewInMusicbrainz') }}</a></span>
    </p>
  </div>
</template>

<script lang="ts" setup>
import type { MediaInfo } from '~~/server/entity/media/MediaInfo';
import noCover from '~/assets/no-cover.png';

type TrackDetail = MediaInfo & { albumMbid: string | null };

const { locale } = useI18n();
const tid = useRoute().params.tid as string;
const token = useCookie("nafynToken").value;

const { data: track } = await useAsyncData<TrackDetail>(`track-${tid}`, () => {
  return token
    ? $fetch(`/api/v1/track/${tid}`, { headers: { Authorization: token } })
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

async function requestMedia(musicbrainzId: string, type: "album" | "track", toastTitle: string | null) {
  if (!token) return;

  try {
    await $fetch("/api/v1/request", {
      method: "POST",
      headers: { Authorization: token },
      body: { id: musicbrainzId, type }
    });

    sendToast(toastTitle ?? (track.value?.title ?? null), $t(`${type}.requested`))
  } catch (e) {
    let err = (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? (e as string) ?? $t('album.error');
    sendToast(toastTitle ?? (track.value?.title ?? null), err, false)
  }
}

function sendToast(title: string | null, message: string, success: boolean = true) {
  useToast().sendToast({
    content: message,
    tint: success ? "green" : "red",
    icon: null,
    title
  })
}
</script>

<style scoped>
.track {
  max-width: 900px;
  margin: calc(15vh - 10px) auto;
}

.track .head {
  display: flex;
  flex-direction: row;
  gap: 30px;
  margin-bottom: 40px;
}

.track .head .header {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 20px;
}

.track .cover {
  width: 250px;
  height: 250px;
  aspect-ratio: 1 / 1;
  border-radius: 15px;
  background: #00000040;
}

.track .meta {
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.track .meta button {
  margin: 1.2em 0;
  align-self: flex-start;
}

.track .type {
  text-transform: uppercase;
  font-size: 1.0em;
  color: #ffffffae;
  border: #ffffffae 1px solid;
  border-radius: 250px;
  padding: 0.2em 1.0em;
}

.track .artist {
  font-family: "Instrument-Italic";
}

.track .album-link {
  font-size: 0.85em;
  color: #666666;
  text-decoration: none;
  margin-top: 4px;
}

.track .album-link:hover {
  text-decoration: underline;
}

.track .details {
  font-size: 0.85em;
  color: #666666;
  margin: 1em 0;
}

@media screen and (max-width: 800px) {
  .track {
    margin: calc(15vh - 10px) 1.2em;
  }

  .track .type {
    font-size: 0.75em;
  }

  .track .head {
    flex-direction: column;
  }

  .track .head .header {
    flex-direction: column-reverse;
    align-items: start;
    gap: 0;
  }

  .track .head .cover {
    margin: 0 auto;
  }
}
</style>