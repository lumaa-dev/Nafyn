<template>
  <div class="mixpage" v-if="mix">
    <div class="mix-header">
      <div class="mix-cover">
        <MixCover :covers="mix.covers" :label="title" eager />
      </div>
      <div class="meta">
        <span class="kicker">{{ $t('mix.kicker') }}</span>
        <h1>{{ title }}</h1>
        <p class="description">{{ $t('mix.summary', { familiar: familiar.length, suggested: suggestions.length }) }}</p>
        <p class="description" v-if="mix.topArtists.length">{{ mix.topArtists.slice(0, 4).join(', ') }}</p>
        <p class="description">{{ $t('mix.updated', { date: formatDate(mix.refreshedAt) }) }}</p>
        <div class="actions">
          <button type="button" filled :disabled="familiar.length === 0" @click="playFrom(0)">{{ $t('playlist.play') }}</button>
          <button type="button" filled :disabled="familiar.length === 0" @click="shuffle">{{ $t('playlist.shuffle') }}</button>
          <!-- DESIGN.md "Icon-only buttons": a circle, an accessible label and a tooltip -->
          <button type="button" class="icon-only" :disabled="refreshing" :aria-label="$t('mix.refresh')" :title="$t('mix.refresh')" @click="refreshMixes">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
          </button>
        </div>
      </div>
    </div>

    <ol class="mix-tracks">
      <li v-for="entry in mix.tracks" :key="entry.position" :class="{ playing: entry.media && currentTrack?.id === entry.media.id, suggestion: !entry.familiar }"
          @contextmenu="onRowMenu($event, entry)">
        <template v-if="entry.media">
          <CoverImage :src="coverSrc(entry.media)" @click="playMedia(entry.media)" />
          <span class="col" @click="playMedia(entry.media)">
            <span class="title">{{ entry.media.title }}</span>
            <span class="artist">{{ entry.media.artistName }}</span>
            <span class="reason">{{ trackReason(entry.reason) }}</span>
          </span>
          <span class="duration">{{ formatDuration(entry.media.duration) }}</span>
          <button type="button" class="ellipsis" @click.stop="onRowMenu($event, entry)" :aria-label="$t('menu.more')" :title="$t('menu.more')">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
          </button>
        </template>
        <template v-else-if="entry.suggestion">
          <CoverImage :src="coverArtUrl(entry.suggestion.coverArt)" />
          <NuxtLink class="col" :to="`/t/${entry.suggestion.recordingId}`">
            <span class="title">{{ entry.suggestion.title }}</span>
            <span class="artist">{{ entry.suggestion.artist }}</span>
            <span class="reason">{{ $t('mix.suggested') }} · {{ trackReason(entry.reason) }}</span>
          </NuxtLink>
          <span class="duration">{{ entry.suggestion.durationMs ? formatDuration(Math.round(entry.suggestion.durationMs / 1000)) : '' }}</span>
          <span class="suggestion-actions">
            <button type="button" class="icon-only preview" :disabled="failedIds.has(entry.suggestion.recordingId)" :aria-pressed="playingId === entry.suggestion.recordingId"
                    :aria-label="playingId === entry.suggestion.recordingId ? $t('preview.stop') : $t('preview.play')"
                    :title="failedIds.has(entry.suggestion.recordingId) ? $t('preview.none') : playingId === entry.suggestion.recordingId ? $t('preview.stop') : $t('preview.play')"
                    @click="togglePreview(entry.suggestion.recordingId)">
              <svg v-if="playingId === entry.suggestion.recordingId" viewBox="0 0 24 24" width="20" height="20" fill="#000"><rect x="6" y="6" width="12" height="12" rx="1" /></svg>
              <svg v-else viewBox="0 0 24 24" width="20" height="20" fill="#000"><path d="M8 5v14l11-7z" /></svg>
            </button>
            <button type="button" filled="hollow" :disabled="requested.has(entry.suggestion.recordingId)" @click="requestTrack(entry.suggestion)">
              {{ requested.has(entry.suggestion.recordingId) ? $t('track.alreadyRequested') : $t('track.request') }}
            </button>
          </span>
        </template>
      </li>
    </ol>
  </div>
  <LoadError v-else-if="error" :error="error" />
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import type { MixLabel } from '~~/server/utils/recommender/mixes/types';
import { useAuthToken } from '~/composables/useAuthToken';
import { coverArtUrl, coverSrc } from '~/composables/useCover';
import { usePreview } from '~/composables/usePreview';
import { attributeMix } from '~/composables/useRecFeedback';
import { type MixTrackReason, useRecLabels } from '~/composables/useRecLabels';
import { formatDuration } from '~/utils/format';

interface Suggestion { recordingId: string, title: string, artist: string, album: string | null, albumId: string | null, coverArt: string | null, durationMs: number | null, releasedAt: number | null }
interface Entry { position: number, familiar: boolean, confidence: number, reason: MixTrackReason, media: (MediaRow & { inLibrary: boolean }) | null, suggestion: Suggestion | null }
interface Mix { id: string, label: MixLabel, title: string, topArtists: string[], trackCount: number, familiarCount: number, covers: string[], refreshedAt: number, tracks: Entry[] }

const route = useRoute();
const id = computed(() => String(route.params.id));
const token = useAuthToken().token.value;
const { locale, t } = useI18n();
const { mixTitle, trackReason } = useRecLabels();

const { data: mix, error } = await useAsyncData<Mix | null>(`mix-${id.value}`, () => token
  ? $fetch<Mix>(`/api/v1/recommendations/mixes/${id.value}`, { headers: { Authorization: token } })
  : Promise.resolve(null), { deep: true });

const title = computed(() => mixTitle(mix.value?.label, mix.value?.title ?? ""));
useHead({ title: () => title.value || t('mix.kicker') });

const familiar = computed(() => (mix.value?.tracks ?? []).filter((e) => e.media).map((e) => e.media!));
const suggestions = computed(() => (mix.value?.tracks ?? []).filter((e) => e.suggestion).map((e) => e.suggestion!));

// a For You card that led here: its feedback covers these tracks and suggestions
watch(mix, (m) => {
  if (m && import.meta.client) attributeMix(m.id, familiar.value.map((x) => x.id), suggestions.value.map((x) => x.recordingId));
}, { immediate: true });

function formatDate(ms: number): string {
  return new Intl.DateTimeFormat(locale.value, { dateStyle: "medium" }).format(new Date(ms));
}

// playback: the familiar tracks, in the mix's order (suggestions are not on the server: they are previewed)
const { currentTrack, play } = useUnity();

function playFrom(index: number) {
  const queue = familiar.value;
  if (queue[index]) play(queue[index]!, queue);
}

function playMedia(media: MediaRow) {
  playFrom(familiar.value.findIndex((m) => m.id === media.id));
}

function shuffle() {
  const shuffled = [...familiar.value].sort(() => Math.random() - 0.5);
  if (shuffled[0]) play(shuffled[0], shuffled);
}

const { playingId, failedIds, togglePreview } = usePreview();

// requesting a suggestion: the button disables before the call (DESIGN.md / useMediaRequest), back on failure only
const { request } = useMediaRequest();
const requested = ref(new Set<string>());

async function requestTrack(s: Suggestion) {
  requested.value = new Set([...requested.value, s.recordingId]);
  if (!await request(s.recordingId, "track", s.title)) {
    const next = new Set(requested.value);
    next.delete(s.recordingId);
    requested.value = next;
  }
}

const refreshing = ref(false);

async function refreshMixes() {
  if (!token) return;
  refreshing.value = true;
  try {
    await $fetch("/api/v1/recommendations/mixes/refresh", { method: "POST", headers: { Authorization: token } });
    useToast().sendToast({ title: title.value, content: t('mix.refreshStarted'), tint: null, icon: null });
  } catch (e) {
    refreshing.value = false;
    useToast().sendError(title.value, e, t('common.error'));
  }
}

// DESIGN.md "Context Menus": a familiar track has the same menu as anywhere else (owned or not)
const { openMenu } = useMediaMenu();

function onRowMenu(e: MouseEvent, entry: Entry) {
  if (!entry.media) return;
  e.preventDefault();
  void openMenu(e, { kind: "track", media: entry.media, owned: entry.media.inLibrary });
}
</script>

<style>
/* this element IS `.view` (app.vue): its margin clears the Header and the sidebar column, so only the size is set */
.mixpage {
  max-width: 1100px;
  padding-top: 40px;
}

.mix-header {
  display: flex;
  flex-wrap: wrap;
  gap: 30px;
  align-items: flex-end;
  margin-bottom: 30px;
}

.mix-cover {
  width: min(260px, 100%);
}

.mixpage .meta {
  flex: 1 1 260px;
  min-width: 0;
}

.mixpage .kicker {
  font-size: 0.85em;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #ffffff;
}

.mixpage h1 {
  margin: 4px 0 8px;
  overflow-wrap: anywhere;
}

.mixpage .description {
  margin: 2px 0;
  color: #ffffff;
}

.mixpage .actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  margin-top: 14px;
}

.mix-tracks {
  list-style: none;
  padding: 0;
  margin: 0;
}

.mix-tracks li {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 8px 6px;
  border-radius: 8px;
  transition: background-color 0.2s ease-out;
}

.mix-tracks li:hover,
.mix-tracks li.playing {
  background: #ffffff14;
}

.mix-tracks li.playing {
  outline: 1px solid #ffffffae;
}

.mix-tracks li > img {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: 4px;
  cursor: pointer;
}

.mix-tracks .col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  cursor: pointer;
  color: inherit;
  text-decoration: none;
}

.mix-tracks .col > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mix-tracks .title {
  font-family: "Instrument-Serif", serif;
  font-size: 1.15em;
  color: #ffffff;
}

.mix-tracks .artist {
  color: #ffffff;
  font-size: 0.9em;
}

.mix-tracks .reason {
  color: #ffffff;
  opacity: 0.85;
  font-size: 0.8em;
  font-style: italic;
}

.mix-tracks .duration {
  color: #ffffff;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}

.mix-tracks .suggestion-actions {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-shrink: 0;
}

.mix-tracks .ellipsis {
  background: none;
  border: none;
  color: #ffffff;
  cursor: pointer;
  padding: 6px;
}

@media screen and (max-width: 800px) {
  .mix-tracks .duration {
    display: none;
  }

  .mix-tracks li {
    flex-wrap: wrap;
  }

  .mix-tracks .suggestion-actions {
    width: 100%;
    justify-content: flex-end;
  }
}

@media (prefers-reduced-motion: reduce) {
  .mix-tracks li {
    transition: none;
  }
}
</style>
