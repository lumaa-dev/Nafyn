<template>
  <div class="transfer-page">
    <div class="transfer-heading">
      <img v-if="meta?.logo" :src="meta.logo" :class="{ wordmark: meta.wordmark }" :alt="meta.wordmark ? providerName : ''" draggable="false">
      <h1>{{ $t('transfer.select.title') }}</h1>
    </div>

    <template v-if="overview">
      <p v-if="overview.account" class="transfer-intro">{{ $t('transfer.select.account', { name: overview.account }) }}</p>

      <section class="transfer-section">
        <label v-if="overview.capabilities.likedTracks" class="transfer-option">
          <input v-model="likedTracks" type="checkbox">
          <span class="col">
            <span class="title">{{ $t('transfer.select.liked') }}</span>
            <span v-if="overview.likedTracks !== null" class="artist">{{ $t('transfer.select.count', { n: overview.likedTracks }) }}</span>
          </span>
        </label>
        <label v-if="overview.capabilities.albums" class="transfer-option">
          <input v-model="albums" type="checkbox">
          <span class="col">
            <span class="title">{{ $t('transfer.select.albums') }}</span>
            <span v-if="overview.albums !== null" class="artist">{{ $t('transfer.select.count', { n: overview.albums }) }}</span>
          </span>
        </label>
        <label v-if="overview.capabilities.artists" class="transfer-option">
          <input v-model="artists" type="checkbox">
          <span class="col">
            <span class="title">{{ $t('transfer.select.artists') }}</span>
            <span class="artist">
              <template v-if="overview.artists !== null">{{ $t('transfer.select.count', { n: overview.artists }) }} &middot; </template>{{ $t('transfer.select.artistsNote') }}
            </span>
          </span>
        </label>
      </section>

      <section v-if="overview.capabilities.playlists" class="transfer-section">
        <div class="transfer-row">
          <h2>{{ $t('transfer.select.playlists') }}</h2>
          <button v-if="overview.playlists.length > 0" type="button" class="text-button" @click="toggleAllPlaylists">
            {{ allPlaylistsSelected ? $t('transfer.select.none') : $t('transfer.select.all') }}
          </button>
        </div>
        <p v-if="overview.playlists.length === 0" class="transfer-note">{{ $t('transfer.select.noPlaylists') }}</p>
        <label v-for="p in overview.playlists" :key="p.id" class="transfer-option">
          <input v-model="playlists" type="checkbox" :value="p.id">
          <span class="transfer-cover" :style="p.image ? { backgroundImage: `url(${p.image})` } : {}" />
          <span class="col">
            <span class="title">{{ p.title }}</span>
            <span v-if="p.trackCount !== null" class="artist">{{ $t('transfer.select.tracks', { n: p.trackCount }) }}</span>
          </span>
        </label>
      </section>

      <p class="transfer-note">{{ $t('transfer.select.bypass') }}</p>
      <div class="transfer-actions">
        <button type="button" filled :disabled="!hasSelection || starting" @click="start">
          {{ starting ? $t('transfer.select.starting') : $t('transfer.select.start') }}
        </button>
      </div>
    </template>

    <template v-else-if="error">
      <p class="transfer-error">{{ error }}</p>
      <NuxtLink to="/settings?tab=import" class="transfer-link">{{ $t('transfer.callback.back') }}</NuxtLink>
    </template>
    <p v-else class="transfer-intro">{{ $t('transfer.connecting') }}</p>
  </div>
</template>

<script lang="ts" setup>
import '~/assets/css/transfer.css';
import type { TransferJob, TransferOverview } from '~~/server/entity/Transfer';

const route = useRoute();
const token = useCookie("nafynToken").value ?? "";
const sessionId = typeof route.query.session === "string" ? route.query.session : "";

const overview = ref<TransferOverview | null>(null);
const error = ref<string | null>(null);

const likedTracks = ref(true);
const albums = ref(false);
const artists = ref(false);
const playlists = ref<string[]>([]);
const starting = ref(false);

const meta = computed(() => overview.value ? TRANSFER_SOURCE_META[overview.value.provider] : null);
const providerName = computed(() => overview.value ? $t(`transfer.providers.${overview.value.provider}`) : "");

const allPlaylistsSelected = computed(() => !!overview.value && overview.value.playlists.length > 0 && playlists.value.length === overview.value.playlists.length);
const hasSelection = computed(() => likedTracks.value || albums.value || artists.value || playlists.value.length > 0);

function toggleAllPlaylists() {
  playlists.value = allPlaylistsSelected.value ? [] : overview.value!.playlists.map((p) => p.id);
}

// client-only: reading a library can take a few seconds, and the session is in the server's memory anyway
onMounted(async () => {
  if (!sessionId) {
    error.value = $t('transfer.select.expired');
    return;
  }
  try {
    overview.value = await $fetch<TransferOverview>(`/api/v1/transfer/session/${encodeURIComponent(sessionId)}`, { headers: { Authorization: token } });
    likedTracks.value = overview.value.capabilities.likedTracks;
  } catch (e) {
    error.value = transferErrorMessage(e, $t('transfer.select.expired'));
  }
});

async function start() {
  starting.value = true;
  try {
    const job = await $fetch<TransferJob>("/api/v1/transfer/jobs", {
      method: "POST",
      headers: { Authorization: token },
      body: {
        sessionId,
        selection: { likedTracks: likedTracks.value, albums: albums.value, artists: artists.value, playlists: playlists.value }
      }
    });
    await navigateTo(`/transfer/${job.id}`, { replace: true });
  } catch (e) {
    useToast().sendToast({ title: $t('transfer.title'), content: transferErrorMessage(e, $t('settings.profile.error')), tint: "red", icon: null });
    starting.value = false;
  }
}
</script>

<style>
.text-button {
  font-family: "Discy";
  font-size: 0.65em;
  color: #999999;
  text-decoration: underline;
}

.transfer-option {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #00000030;
  cursor: pointer;
  min-width: 0;
}

.transfer-option .col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.transfer-option .title {
  font-size: 0.8em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.transfer-option .artist {
  font-family: "Discy";
  font-size: 0.55em;
  color: #999999;
}

.transfer-cover {
  width: 36px;
  height: 36px;
  border-radius: 6px;
  background-color: #00000050;
  background-size: cover;
  background-position: center;
  flex-shrink: 0;
}
</style>
