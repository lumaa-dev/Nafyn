<template>
  <div class="profile" v-if="profile">
    <!-- a div, not a <header>: Header.vue's unscoped bare `header {}` rule would turn it into a second fixed bar -->
    <div class="profile-head">
      <div class="avatar" :style="avatarStyle" role="img" :aria-label="name">
        <span v-if="!profile.avatar" aria-hidden="true">{{ name.charAt(0).toUpperCase() }}</span>
      </div>
      <div class="who">
        <h1>{{ name }}</h1>
        <p class="handle">@{{ profile.username }}</p>
        <p class="stats">
          <span>{{ $t('profile.tracks', { count: profile.trackCount }, profile.trackCount) }}</span>
          <span> &middot; {{ $t('profile.playlistCount', { count: profile.playlists.length }, profile.playlists.length) }}</span>
        </p>
        <p class="links" v-if="profile.lastFm || profile.discogs">
          <a v-if="profile.lastFm" :href="`https://www.last.fm/user/${encodeURIComponent(profile.lastFm)}`" rel="noopener noreferrer">Last.fm</a>
          <a v-if="profile.discogs" :href="`https://www.discogs.com/user/${encodeURIComponent(profile.discogs)}`" rel="noopener noreferrer">Discogs</a>
        </p>
      </div>
    </div>

    <h2 class="section">{{ $t('profile.playlists') }}</h2>
    <div class="grid" v-if="profile.playlists.length > 0">
      <NuxtLink v-for="playlist in profile.playlists" :key="playlist.id" :to="`/l/playlist/${playlist.id}`" class="pcard">
        <img :src="imageUrl(playlist)" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" alt="" />
        <p class="title">{{ playlist.title }}</p>
        <p class="sub">{{ $t('profile.playlistTracks', { count: playlist.trackCount }, playlist.trackCount) }}</p>
      </NuxtLink>
    </div>
    <p class="empty" v-else>{{ $t('profile.noPlaylists') }}</p>
  </div>
</template>

<script lang="ts" setup>
// A user's public profile: reachable without a login (like a public playlist), with Open Graph tags and a
// Discord component embed rendered server-side, because the crawlers behind link previews run no scripts.
import noCover from '~/assets/no-cover.png';

interface PublicProfile {
  id: string;
  username: string;
  displayName: string | null;
  avatar: string | null;
  lastFm: string | null;
  discogs: string | null;
  trackCount: number;
  playlists: { id: string; title: string; description: string | null; image: string | null; trackCount: number; updatedAt: number }[];
}

const username = useRoute().params.username as string;

const { data: profile, error } = await useAsyncData<PublicProfile>(`profile-${username}`, () => $fetch(`/api/v1/profile/${encodeURIComponent(username)}`));
useLoadErrorToast(error);

const name = computed(() => profile.value?.displayName ?? profile.value?.username ?? username);
const avatarStyle = computed(() => profile.value?.avatar
  ? { backgroundImage: `url(/api/v1/user/${profile.value.id}/avatar?v=${encodeURIComponent(profile.value.avatar)})` }
  : {});

function imageUrl(playlist: { id: string; image: string | null }): string {
  return playlist.image ? `/api/v1/playlist/${playlist.id}/image?v=${encodeURIComponent(playlist.image)}` : noCover;
}

const requestUrl = useRequestURL();
const embed = computed(() => {
  const p = profile.value;
  if (!p) return null;

  return buildProfileEmbed({
    username: p.username,
    displayName: p.displayName,
    avatar: p.avatar,
    userId: p.id,
    trackTotal: p.trackCount,
    playlists: p.playlists.map((playlist) => ({ id: playlist.id, title: playlist.title, trackCount: playlist.trackCount, image: playlist.image })),
    origin: requestUrl.origin,
    labels: {
      trackCount: $t('profile.tracks', { count: p.trackCount }, p.trackCount),
      playlistCount: $t('profile.playlistCount', { count: p.playlists.length }, p.playlists.length),
      more: (count: number) => $t('playlist.embed.more', { count }, count),
      playlistTracks: (count: number) => $t('profile.playlistTracks', { count }, count),
      open: $t('profile.embedOpen')
    }
  });
});

useSeoMeta({
  title: () => embed.value ? `Nafyn - ${embed.value.title}` : "Nafyn",
  description: () => embed.value?.description,
  ogType: () => embed.value ? "profile" : undefined,
  ogSiteName: () => embed.value ? "Nafyn" : undefined,
  ogTitle: () => embed.value?.title,
  ogDescription: () => embed.value?.description,
  ogUrl: () => embed.value?.url,
  ogImage: () => embed.value?.image ?? undefined,
  twitterCard: () => embed.value ? "summary" : undefined
});

// Discord reads the payload from the server-rendered <head>; the string is already escaped for a script element
useHead(() => ({
  script: embed.value
    ? [{ id: "discord:component-embed", type: "application/json", innerHTML: embed.value.discordEmbed }]
    : []
}));
</script>

<style scoped>
/* this element is `.view` (app.vue): its margin clears the Header and the sidebar, so only the size and the
   breathing room under the Header's gradient are set here */
.profile {
  max-width: 1100px;
  padding-top: 40px;
}

.profile-head {
  display: flex;
  align-items: center;
  gap: 30px;
  margin-bottom: 40px;
}

.avatar {
  width: 160px;
  height: 160px;
  flex-shrink: 0;
  border-radius: 50%;
  background-color: #00000050;
  background-size: cover;
  background-position: center;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 3em;
}

.who {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.who h1 {
  overflow-wrap: anywhere;
}

.handle {
  font-family: var(--font-discy);
  font-size: 0.7em;
  color: #ffffff;
}

.stats {
  font-size: 0.9em;
  margin-top: 6px;
}

.links {
  display: flex;
  gap: 14px;
  font-size: 0.8em;
}

.section {
  font-size: 1.1em;
  margin-bottom: 14px;
}

.empty {
  font-size: 0.85em;
}

.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 20px;
}

.pcard {
  text-decoration: none;
  min-width: 0;
}

.pcard img {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  object-fit: cover;
  background: #00000040;
}

.pcard .title {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pcard .sub {
  font-size: 0.85em;
  color: #ffffff;
  opacity: 0.85;
}

@media screen and (max-width: 800px) {
  .profile-head {
    flex-direction: column;
    text-align: center;
  }

  .avatar {
    width: 120px;
    height: 120px;
  }

  .links {
    justify-content: center;
  }

  .grid {
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  }
}
</style>
