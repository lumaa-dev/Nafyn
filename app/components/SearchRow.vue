<template>
  <NuxtLink class="srow" :to="to">
    <CoverImage class="cover" :class="{ round: entry.kind === 'artist' }" :src="cover" />
    <span class="col">
      <span class="title">{{ title }}</span>
      <span class="sub">{{ subtitle }}</span>
    </span>
    <span v-if="entry.kind === 'track' && entry.media && entry.media.duration > 0" class="duration">{{ formatDuration(entry.media.duration) }}</span>
  </NuxtLink>
</template>

<script lang="ts" setup>
import type { SearchEntry } from '~~/server/entity/media/SearchEntry';

// one row of the search list: a track, an album or an artist (DESIGN.md "Search"); the kind is written out, never
// told by the shape of the cover alone
const props = defineProps<{ entry: SearchEntry }>();

const to = computed(() => {
  const { entry } = props;
  if (entry.kind === "artist") return `/ar/${entry.artist?.musicbrainzId}`;
  return entry.kind === "track" ? `/t/${entry.media?.id}` : `/a/${entry.media?.id}`;
});

const cover = computed(() => props.entry.kind === "artist" ? props.entry.artist?.image ?? null : props.entry.media?.coverArt ?? null);
const title = computed(() => props.entry.kind === "artist" ? props.entry.artist?.name : props.entry.media?.title);

const subtitle = computed(() => {
  const { entry } = props;
  if (entry.kind === "artist") return [$t('search.kind.artist'), entry.artist?.description].filter(Boolean).join(" · ");
  const media = entry.media;
  const artist = typeof media?.artist === "string" ? media.artist : media?.artist.name;
  const kind = entry.kind === "track"
    ? $t('search.kind.track')
    : media?.type === "ep" ? $t('search.kind.ep') : $t('search.kind.album');
  const album = entry.kind === "track" ? media?.album?.title : null;
  return [kind, artist, album].filter(Boolean).join(" · ");
});
</script>

<style>
.srow {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 15px;
  padding: 10px 0;
  min-width: 0;
  font-family: "Instrument-Serif";
  text-decoration: none;
  border-radius: 8px;
  transition: background 0.2s ease-out;
}

.srow:hover,
.srow:focus-visible {
  background: #ffffff14;
}

.srow .cover {
  flex-shrink: 0;
  width: 56px;
  height: 56px;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  background: #00000040;
}

.srow .cover.round {
  border-radius: 50%;
}

.srow .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.srow .title,
.srow .sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.srow .title {
  font-weight: 700;
}

.srow .sub {
  font-size: 0.85em;
  color: var(--tint-fg, #ffffffae);
  font-family: var(--font-discy);
}

.srow .duration {
  flex-shrink: 0;
  color: var(--tint-fg, #ffffffae);
  font-variant-numeric: tabular-nums;
  font-family: var(--font-discy);
  font-size: 0.7em;
}

@media (prefers-reduced-motion: reduce) {
  .srow {
    transition: none;
  }
}
</style>
