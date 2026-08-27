<template>
  <ol class="top-entities">
    <li v-for="entity in entities" :key="entity.entityId">
      <span class="rank">{{ entity.rank }}</span>

      <component
        :is="hrefFor(entity) ? 'NuxtLink' : 'div'"
        :to="hrefFor(entity)"
        class="row"
      >
        <img v-if="showCover" :src="entity.cover ?? noCover" alt="" @error="onCoverError">
        <span class="col">
          <span class="title">{{ entity.title ?? $t('insights.unknownEntity') }}</span>
          <span class="artist">{{ entity.subtitle ?? '' }}</span>
        </span>
        <span class="metric">{{ metricFor(entity) }}</span>
      </component>
    </li>
  </ol>
</template>

<script lang="ts" setup>
import noCover from '~/assets/no-cover.png';

// A ranked list with cover art, linking through to the existing detail pages where one exists.
//
// Entries whose underlying media has been deleted still appear - that is the point of the display snapshot
// stored on each aggregate row - but they get no link, because there is nothing left to link to.
export interface RankedEntity {
  entityType: "track" | "album" | "artist" | "playlist",
  entityId: string,
  rank: number,
  playCount: number,
  minutes: number,
  title: string | null,
  subtitle: string | null,
  cover: string | null
}

const props = defineProps<{
  entities: RankedEntity[],
  metric?: "plays" | "minutes",
  showCover?: boolean,
  /** ids still present in the user's library; entries outside it render unlinked */
  availableIds?: Set<string>
}>();

function hrefFor(entity: RankedEntity): string | undefined {
  if (props.availableIds && !props.availableIds.has(entity.entityId)) return undefined;

  // route prefixes per app/pages/README.md
  switch (entity.entityType) {
    case "track": return `/l/t/${entity.entityId}`;
    case "album": return `/l/a/${entity.entityId}`;
    case "artist": return `/ar/${entity.entityId}`;
    case "playlist": return `/l/playlist/${entity.entityId}`;
  }
}

function metricFor(entity: RankedEntity): string {
  return props.metric === "minutes"
    ? $t('insights.metric.minutes', { count: entity.minutes })
    : $t('insights.metric.plays', { count: entity.playCount });
}

function onCoverError(e: Event) {
  (e.target as HTMLImageElement).src = noCover;
}
</script>

<style>
.top-entities {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
  padding: 0;
}

.top-entities li {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.top-entities .rank {
  font-family: "Discy";
  font-size: 0.7em;
  color: #666666;
  width: 22px;
  flex-shrink: 0;
  text-align: right;
}

.top-entities .row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
  min-width: 0;
  padding: 6px 10px;
  border-radius: 10px;
  background: #00000030;
  color: inherit;
  text-decoration: none;
}

.top-entities img {
  width: 40px;
  height: 40px;
  border-radius: 6px;
  object-fit: cover;
  background: #00000040;
  flex-shrink: 0;
}

.top-entities .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}

.top-entities .title,
.top-entities .artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.top-entities .title { font-size: 0.85em; }
.top-entities .artist { font-size: 0.65em; color: #666666; }

.top-entities .metric {
  font-family: "Discy";
  font-size: 0.7em;
  color: #ffffffae;
  flex-shrink: 0;
  white-space: nowrap;
}
</style>
