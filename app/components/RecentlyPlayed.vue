<template>
  <div class="recent" :class="variant" v-if="recentlyPlayed.length > 0">
    <NuxtLink v-for="item in recentlyPlayed" :key="`${item.type}-${item.refId}`" :to="item.href" class="recent-card">
      <img :src="coverSrc(item)" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" />
      <p class="title">{{ item.title }}</p>
      <p class="subtitle" v-if="item.subtitle">{{ item.subtitle }}</p>
    </NuxtLink>
  </div>
  <p class="recent-empty" v-else>{{ $t("library.recentlyPlayedEmpty") }}</p>
</template>

<script lang="ts" setup>
import type { RecentlyPlayedEntry } from '~~/server/core/recentlyPlayed';
import noCover from '~/assets/no-cover.png';

defineProps<{ variant: "grid" | "scroll" }>();

const token = useCookie("nafynToken").value;

const { data: recentlyPlayed } = await useAsyncData<RecentlyPlayedEntry[]>("recently-played", () => {
  return token
    ? $fetch("/api/v1/library/recently-played", { headers: { Authorization: token } })
    : Promise.resolve([]);
}, { default: () => [] });

function coverSrc(item: RecentlyPlayedEntry): string {
  if (item.type === "playlist") {
    return item.playlistImage ? `/api/v1/playlist/${item.refId}/image?token=${encodeURIComponent(token ?? "")}&v=${item.playlistImage}` : noCover;
  }
  return item.coverArt ?? noCover;
}
</script>

<style>
.recent-empty {
  color: #666666;
}

.recent.scroll {
  display: flex;
  flex-direction: row;
  gap: 20px;
  overflow-x: auto;
  overflow-y: hidden;
  padding-bottom: 10px;
}

.recent.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 20px;
}

.recent-card {
  text-decoration: none;
  color: inherit;
  font-family: "Instrument-Serif";
}

.recent.scroll .recent-card {
  flex: 0 0 auto;
  width: 160px;
}

.recent-card img {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 8px;
  object-fit: cover;
  background: #00000040;
}

.recent.scroll .recent-card img {
  width: 160px;
  height: 160px;
}

.recent-card .title {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.recent-card .subtitle {
  font-size: 0.85em;
  color: #666666;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
