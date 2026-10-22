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
        <div class="upcoming" v-if="!track.released">
          <span class="label">{{ $t('upcoming.label') }}</span>
          <ReleaseCountdown v-if="track.releaseDate && track.releaseDatePrecision === 'day'" class="value" :date="track.releaseDate" @released="refreshNuxtData(`track-${tid}`)" />
          <span v-else-if="track.releaseDate" class="value">{{ $t('upcoming.expected', { date: formatPartialDate(track.releaseDate, track.releaseDatePrecision) }) }}</span>
        </div>
        <button filled :disabled="track.requested || !!track.inLibrary" @click="requestTrack" v-if="track.released">{{ track.inLibrary ? $t('track.inLibrary') : track.requested ? $t('track.alreadyRequested') : $t('track.request') }}</button>
        <button v-else-if="!track.released" :filled="track.subscribed ? 'hollow' : ''" :disabled="subscriptionPending" @click="toggleSubscription">
          {{ track.subscribed ? $t('upcoming.following') : $t('upcoming.notifyMe') }}
        </button>
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
import { useAuthToken } from '~/composables/useAuthToken';
import ReleaseCountdown from '~/components/ReleaseCountdown.vue';

type TrackDetail = MediaInfo & {
  albumMbid: string | null,
  releaseDatePrecision: "day" | "month" | "year" | null,
  released: boolean,
  subscribed: boolean,
  requested: boolean
};

const { locale } = useI18n();
const tid = useRoute().params.tid as string;
const { token } = useAuthToken();

// deep: see the matching note in a/[aid].vue
const { data: track, error } = await useAsyncData<TrackDetail>(`track-${tid}`, () => {
  return token.value
    ? $fetch(`/api/v1/track/${tid}`, { headers: { Authorization: token.value } })
    : Promise.reject(new Error("Not authenticated"));
}, { deep: true });
useLoadErrorToast(error);

function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString(locale.value, { year: "numeric", month: "long", day: "numeric" });
}

// "2027" / "November 2027" for a date MusicBrainz only partly knows
function formatPartialDate(date: string | Date, precision: "day" | "month" | "year" | null): string {
  const d = new Date(date);
  if (precision === "year") return String(d.getUTCFullYear());
  if (precision === "month") return d.toLocaleDateString(locale.value, { year: "numeric", month: "long", timeZone: "UTC" });
  return formatDate(date);
}

const { toggle, pending: subscriptionPending } = useReleaseSubscription();

async function toggleSubscription() {
  if (!track.value) return;
  track.value.subscribed = await toggle(track.value.id, "track", track.value.subscribed, track.value.title);
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

const { request } = useMediaRequest();

// disabled before the request goes out, re-enabled only if it failed (see a/[aid].vue)
async function requestTrack() {
  const current = track.value;
  if (!current || current.requested || current.inLibrary) return;

  current.requested = true;
  if (!await request(current.id, "track", current.title)) current.requested = false;
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

.track .upcoming {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 15px;
}

.track .upcoming .label {
  font-size: 0.75em;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #666666;
}

.track .upcoming .value {
  font-family: "Discy";
  font-size: 1.1em;
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