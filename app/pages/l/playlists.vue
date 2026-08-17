<template>
  <div class="libplaylists">
    <div class="head">
      <h1>{{ $t('playlist.title') }}</h1>
      <button type="button" filled @click="showCreate = true">{{ $t('playlist.create.open') }}</button>
    </div>

    <div class="grid" v-if="playlists.length > 0">
      <NuxtLink v-for="playlist in playlists" :key="playlist.id" :to="`/l/playlist/${playlist.id}`" class="pcard">
        <img :src="imageUrl(playlist)" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" />
        <p class="title">{{ playlist.title }}</p>
        <p class="privacy">{{ $t(`playlist.privacy.${playlist.privacy}`) }}</p>
      </NuxtLink>
    </div>
    <p class="empty" v-else>{{ $t('playlist.empty') }}</p>

    <Teleport to="body">
      <div v-if="showCreate" class="pmodal-backdrop" @click.self="showCreate = false">
        <div class="pmodal">
          <h2>{{ $t('playlist.create.open') }}</h2>

          <label for="title">{{ $t('playlist.form.title') }}</label>
          <input id="title" v-model="newTitle" type="text" maxlength="100">

          <label for="description">{{ $t('playlist.form.description') }}</label>
          <textarea id="description" v-model="newDescription" maxlength="500" rows="3" />

          <label for="privacy">{{ $t('playlist.form.privacy') }}</label>
          <select id="privacy" v-model="newPrivacy">
            <option value="private">{{ $t('playlist.privacy.private') }}</option>
            <option value="public">{{ $t('playlist.privacy.public') }}</option>
          </select>

          <button type="button" filled :disabled="!newTitle.trim() || creating" @click="create">{{ $t('playlist.create.submit') }}</button>
          <button type="button" filled="hollow" @click="showCreate = false">{{ $t('playlist.picker.cancel') }}</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script lang="ts" setup>
import noCover from '~/assets/no-cover.png';

interface PlaylistRow {
  id: string;
  title: string;
  privacy: "public" | "private";
  image: string | null;
}

const token = useCookie("nafynToken").value ?? "";

const { data: playlists, refresh } = await useAsyncData<PlaylistRow[]>("user-playlists", () => {
  return token
    ? $fetch("/api/v1/playlist", { headers: { Authorization: token } })
    : Promise.resolve([]);
}, { default: () => [] });

const showCreate = ref(false);
const creating = ref(false);
const newTitle = ref("");
const newDescription = ref("");
const newPrivacy = ref<"public" | "private">("private");

function imageUrl(playlist: PlaylistRow): string {
  return playlist.image ? `/api/v1/playlist/${playlist.id}/image?token=${encodeURIComponent(token)}&v=${playlist.image}` : noCover;
}

async function create() {
  creating.value = true;
  try {
    await $fetch("/api/v1/playlist", {
      method: "POST",
      headers: { Authorization: token },
      body: { title: newTitle.value.trim(), description: newDescription.value.trim(), privacy: newPrivacy.value }
    });
    showCreate.value = false;
    newTitle.value = "";
    newDescription.value = "";
    newPrivacy.value = "private";
    await refresh();
  } catch (e) {
    const err = (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? $t('settings.profile.error');
    useToast().sendToast({ content: err, tint: "red", icon: null, title: null });
  } finally {
    creating.value = false;
  }
}
</script>

<style>
.libplaylists {
  width: 70vw;
  max-width: 1200px;
  margin: calc(15vh - 10px) auto;
}

.libplaylists .head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 20px;
}

.libplaylists .empty {
  color: #666666;
}

.libplaylists .grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 20px;
}

.libplaylists .pcard img {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  background: #00000040;
  object-fit: cover;
}

.libplaylists .pcard .title {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.libplaylists .pcard .privacy {
  font-size: 0.8em;
  color: #666666;
  text-transform: capitalize;
}

.pmodal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: #00000080;
  display: flex;
  align-items: center;
  justify-content: center;
}

.pmodal {
  background: #1a1a1a;
  border-radius: 16px;
  padding: 24px;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pmodal h2 {
  font-size: 1em;
  margin: 0 0 8px 0;
}

.pmodal label {
  font-size: 0.7em;
  color: #666666;
}

@media screen and (max-width: 800px) {
  .libplaylists {
    margin: calc(15vh - 10px) 1.2em;
  }
}
</style>
