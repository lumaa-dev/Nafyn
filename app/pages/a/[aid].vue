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
        <span class="albumactions">
          <button filled @click="requestMedia(album.id, 'album', album.title)">{{ $t('album.request') }}</button>
          <!-- <button filled="hollow" v-if="albumMediaIds.length > 0" @click="openPicker(albumMediaIds)">{{ $t('playlist.addToPlaylist') }}</button> -->
        </span>
      </div>
    </div>

    <ol class="tracks">
      <h2>{{ $t('album.trackList') }}</h2>
      <li v-for="track in album.tracks" :key="track.id" :class="{ unreleased: !track.released, playing: currentTrack?.id === track.mediaId, playable: track.mediaId }" @click="track.mediaId ? playTrack(track) : undefined" @contextmenu.prevent="track.mediaId ? onTrackContextMenu($event, track.mediaId) : undefined">
        <span class="number">{{ track.trackNumber }}</span>
        <span class="title">{{ track.title }}</span>
        <button filled="hollow" @click.stop="requestTrack(track)" v-if="track.released && (!track.requested && !track.inLibrary)"><img src="../../assets/icons/download.svg" draggable="false"></button>
        <button type="button" class="ellipsis" v-if="track.mediaId" @click.stop="onTrackEllipsis($event, track.mediaId)">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
        </button>
        <span class="duration" v-if="track.duration > 0">{{ formatDuration(track.duration) }}</span>
      </li>
    </ol>

    <ContextMenu ref="trackMenu" :items="trackMenuItems" />
    <PlaylistPickerModal v-model="showPicker" :media-ids="pickerMediaIds" />

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
import type { MediaRow } from '~~/server/core/library';
import noCover from '~/assets/no-cover.png';
import ContextMenu, { type ContextMenuItem } from '~/components/ContextMenu.vue';
import PlaylistPickerModal from '~/components/PlaylistPickerModal.vue';

const { locale } = useI18n();
const aid = useRoute().params.aid as string;
const token = useCookie("nafynToken").value;

const { data: album } = await useAsyncData<AlbumDetail>(`album-${aid}`, () => {
  return token
    ? $fetch(`/api/v1/album/${aid}`, { headers: { Authorization: token } })
    : Promise.reject(new Error("Not authenticated"));
});

const albumMediaIds = computed(() => album.value?.tracks.map((t) => t.mediaId).filter((id): id is string => id !== null) ?? []);

const { currentTrack, play } = usePlayer();

// tracks aren't fetched as full MediaRow rows on the album page (only display fields), so build one client-side
// from data already on hand - just enough to stream/queue/show the track, matching what the actual media row holds
function toMediaRow(track: TrackInfo): MediaRow | null {
  if (!track.mediaId || !album.value) return null;
  const artist = album.value.artist;

  return {
    id: track.mediaId,
    musicbrainzId: track.id,
    title: track.title,
    artistName: typeof artist === "string" ? artist : artist.name,
    artistMbid: typeof artist === "string" ? "" : artist.musicbrainzId,
    album: album.value.title,
    albumId: aid,
    albumType: album.value.type,
    coverArt: album.value.coverArt,
    releaseDate: track.releaseDate ? Math.floor(new Date(track.releaseDate).getTime() / 1000) : null,
    duration: track.duration,
    label: album.value.label,
    fingerprint: null,
    amId: null,
    addedAt: 0
  };
}

function playTrack(track: TrackInfo) {
  const media = toMediaRow(track);
  if (!media) return;

  const queue = album.value!.tracks
    .map((t) => toMediaRow(t))
    .filter((t): t is MediaRow => t !== null);

  play(media, queue, { type: "album", refId: aid });
}

const showPicker = ref(false);
const pickerMediaIds = ref<string[]>([]);

function openPicker(mediaIds: string[]) {
  pickerMediaIds.value = mediaIds;
  showPicker.value = true;
}

const trackMenu = ref<InstanceType<typeof ContextMenu> | null>(null);
const trackMenuItems = ref<ContextMenuItem[]>([]);

function buildTrackMenu(mediaId: string) {
  trackMenuItems.value = [{ label: $t('playlist.addToPlaylist'), action: () => openPicker([mediaId]) }];
}

function onTrackContextMenu(e: MouseEvent, mediaId: string) {
  buildTrackMenu(mediaId);
  trackMenu.value?.openAt(e.clientX, e.clientY);
}

function onTrackEllipsis(e: MouseEvent, mediaId: string) {
  buildTrackMenu(mediaId);
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  trackMenu.value?.openAt(rect.left, rect.bottom);
}

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
    })

    sendToast(toastTitle ?? (album.value?.title ?? null), $t(`${type}.requested`))
  } catch (e) {
    let err = (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? (e as string) ?? $t('album.error');
    sendToast(toastTitle ?? (album.value?.title ?? null), err, false)
  };
}

async function requestTrack(track: TrackInfo) {
  await requestMedia(track.id, "track", track.title);
  
  let i = album.value!.tracks.lastIndexOf(track);
  if (i > 0) {
    track.requested = true;
    album.value!.tracks[i] = track;
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

.album .meta .albumactions {
  display: flex;
  gap: 10px;
}

.album .tracks li .ellipsis {
  background: none;
  border: none;
  color: #666666;
  cursor: pointer;
  font-size: 1.2em;
  width: auto;
  height: fit-content;
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

.album .tracks li.playable {
  cursor: pointer;
}

.album .tracks li.playing .title {
  color: #ffffff;
  font-weight: 700;
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
  font-family: "Discy";
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
  font-family: "Discy";
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
