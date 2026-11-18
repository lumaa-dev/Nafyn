<template>
  <div class="discover">
    <div class="discover-head">
      <h1>{{ $t('discover.title') }}</h1>
      <p v-if="data?.refreshing" class="discover-note" role="status">{{ $t('discover.building') }}</p>
    </div>

    <template v-if="data && data.shelves.length > 0">
      <!-- DESIGN.md "Category grids": one titled, sideways-scrolling grid per shelf, in the order the page was ranked -->
      <ReleaseGrid v-for="shelf in data.shelves" :key="shelf.decisionId" :title="$t(`discover.shelf.${shelf.kind}`)">
        <NuxtLink
          v-for="card in shelf.cards"
          :key="card.actionId"
          :to="card.item.href"
          class="rgrid-card fy-card"
          @click="noteCardOpened(shelf.decisionId, card.slot, card.item.kind, card.item.refId)"
          @contextmenu="onMenu($event, card)"
        >
          <MixCover v-if="card.item.kind === 'mix'" :covers="card.item.covers ?? []" :label="cardTitle(card)" />
          <CoverImage v-else :src="cardCover(card.item)" />
          <p class="title">{{ cardTitle(card) }}</p>
          <p class="subtitle" v-if="card.item.subtitle">{{ card.item.subtitle }}</p>
          <p class="why" v-if="explanation(card.explanation)">{{ explanation(card.explanation) }}</p>
        </NuxtLink>
      </ReleaseGrid>
    </template>

    <!-- 403: the person turned personalization off - said where it can be turned back on -->
    <div v-else-if="statusOf(error) === 403" class="discover-off">
      <p>{{ $t('discover.off') }}</p>
      <button type="button" filled="hollow" @click="navigateTo('/settings?category=privacy')">{{ $t('discover.offLink') }}</button>
    </div>
    <p v-else-if="statusOf(error) === 404" class="discover-note">{{ $t('discover.unavailable') }}</p>
    <LoadError v-else-if="error" :error="error" />
    <p v-else-if="data" class="discover-note">{{ data.refreshing ? $t('discover.buildingFirst') : $t('discover.empty') }}</p>
  </div>
</template>

<script lang="ts" setup>
import type { MixLabel } from '~~/server/utils/recommender/mixes/types';
import type { MediaRow, AlbumRow } from '~~/server/core/library';
import { useAuthToken } from '~/composables/useAuthToken';
import { coverArtUrl, noCoverImage } from '~/composables/useCover';
import { menuAnchor } from '~/composables/useMediaMenu';
import { noteCardOpened } from '~/composables/useRecFeedback';
import { type RecExplanation, useRecLabels } from '~/composables/useRecLabels';

interface CardItem {
  kind: "mix" | "suggestion" | "album" | "playlist" | "track",
  refId: string,
  title: string,
  subtitle: string | null,
  coverArt: string | null,
  coverMediaId: string | null,
  playlistImage: string | null,
  covers?: string[],
  label?: MixLabel,
  href: string
}
interface Card { slot: number, actionId: string, item: CardItem, explanation: RecExplanation }
interface Shelf { decisionId: string, kind: string, row: number, cards: Card[] }
interface HomeResponse { pageId: string, shelves: Shelf[], refreshing: boolean, refreshedAt: number | null }

useHead({ title: () => $t('discover.title') });

const token = useAuthToken().token.value;
const { mixTitle, explanation } = useRecLabels();

// every visit is a new ranking decision (with its own exploration), so the page is never served from cache
const { data, error } = await useAsyncData<HomeResponse | null>("discover", () => {
  if (!token) return Promise.resolve(null);
  return $fetch<HomeResponse>("/api/v1/recommendations/home", {
    headers: { Authorization: token },
    query: { device: "web", tz: -new Date().getTimezoneOffset() }
  });
}, { server: false, getCachedData: () => undefined });

function statusOf(e: unknown): number | undefined {
  return (e as { statusCode?: number } | null)?.statusCode;
}

function cardTitle(card: Card): string {
  return card.item.kind === "mix" ? mixTitle(card.item.label, card.item.title) : card.item.title;
}

function cardCover(item: CardItem): string {
  if (item.kind === "playlist") {
    return item.playlistImage ? `/api/v1/playlist/${item.refId}/image?token=${encodeURIComponent(token ?? "")}&v=${item.playlistImage}` : noCoverImage;
  }
  if (item.coverMediaId) return `/api/v1/library/${item.coverMediaId}/cover`;
  return coverArtUrl(item.coverArt);
}

// DESIGN.md "Context Menus": a library album or a playlist has the same menu here as anywhere else; mixes and
// catalogue suggestions have none (nothing to edit, pin or delete), so the browser's own menu stays
const { openMenu } = useMediaMenu();

async function onMenu(e: MouseEvent, card: Card) {
  if (!token || (card.item.kind !== "album" && card.item.kind !== "playlist" && card.item.kind !== "track")) return;
  e.preventDefault();
  const anchor = menuAnchor(e);
  const headers = { Authorization: token };
  try {
    if (card.item.kind === "album") {
      const detail = await $fetch<{ album: AlbumRow }>(`/api/v1/library/album/${card.item.refId}`, { headers });
      await openMenu(anchor, { kind: "album", album: detail.album });
    } else if (card.item.kind === "track") {
      const media = await $fetch<MediaRow>(`/api/v1/library/track/${card.item.refId}`, { headers });
      await openMenu(anchor, { kind: "track", media });
    } else {
      const detail = await $fetch<{ playlist: { id: string, title: string }, viewer: { isOwner: boolean, isMember: boolean } }>(`/api/v1/playlist/${card.item.refId}`, { headers, query: { limit: 1 } });
      await openMenu(anchor, { kind: "playlist", playlist: detail.playlist, isOwner: detail.viewer.isOwner, isMember: detail.viewer.isMember });
    }
  } catch (err) {
    useToast().sendError(card.item.title, err, $t('common.error'));
  }
}
</script>

<style>
/* this element IS `.view` (app.vue): its margin clears the Header and the sidebar column, so only the size is set */
.discover {
  max-width: 1200px;
  padding-top: 40px;
}

.discover-head {
  margin-bottom: 20px;
}

.discover-note,
.discover-off p {
  color: #ffffffae;
}

.fy-card {
  display: flex;
  flex-direction: column;
  min-width: 0;
  text-decoration: none;
  color: inherit;
  border-radius: 6px;
  transition: opacity 0.2s ease-out;
}

.fy-card:hover {
  opacity: 0.85;
}

.fy-card:focus-visible {
  outline: 2px solid #ffffff;
  outline-offset: 3px;
}

.fy-card > img,
.fy-card > .mixcover {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  object-fit: cover;
}

.fy-card p {
  margin: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fy-card .title {
  margin-top: 6px;
  font-family: "Instrument-Serif", serif;
  font-size: 1.15em;
  color: #ffffff;
}

.fy-card .subtitle {
  font-size: 0.85em;
  color: #ffffff;
}

/* why it is here: secondary, but white like every other text (WCAG AAA on the page background) */
.fy-card .why {
  font-size: 0.8em;
  font-style: italic;
  color: #ffffff;
  opacity: 0.85;
}

@media (prefers-reduced-motion: reduce) {
  .fy-card {
    transition: none;
  }
}
</style>
