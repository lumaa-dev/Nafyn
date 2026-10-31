<template>
  <div class="libplaylists bulk-page">
    <div class="head">
      <h1>{{ $t('playlist.title') }}</h1>
      <button type="button" filled @click="showCreate = true">{{ $t('playlist.create.open') }}</button>
    </div>

    <div class="grid" v-if="playlists.length > 0">
      <NuxtLink
        v-for="playlist in playlists"
        :key="playlist.id"
        :to="`/l/playlist/${playlist.id}`"
        class="pcard"
        :class="{ 'selectable-card': selecting, selected: isSelected(playlist.id) }"
        :aria-pressed="selecting ? isSelected(playlist.id) : undefined"
        @click.capture="onCardClick($event, playlist)"
        @contextmenu.prevent="onContextMenu($event, playlist)"
      >
        <img :src="imageUrl(playlist)" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" />
        <p class="title">{{ playlist.title }}</p>
        <p class="privacy">{{ $t(`playlist.privacy.${playlist.privacy}`) }}</p>
        <span v-if="selecting" class="check" :class="{ on: isSelected(playlist.id) }" aria-hidden="true">{{ isSelected(playlist.id) ? '✓' : '' }}</span>
      </NuxtLink>
    </div>
    <p class="empty" v-else-if="!initialLoading">{{ $t('playlist.empty') }}</p>
    <div ref="sentinel" class="scroll-sentinel" />
    <p class="loading-more" v-if="loadingMore">{{ $t('common.loadingMore') }}</p>

    <BulkBar :selecting="selecting" :count="count" :total="playlists.length" @start="start" @stop="stop" @select-all="toggleAll" @actions="onBulkActions" />

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
import type { MenuChange } from '~/composables/useMediaMenu';
import { useAuthToken } from '~/composables/useAuthToken';

interface PlaylistRow {
  id: string;
  ownerId: string;
  title: string;
  privacy: "public" | "private";
  image: string | null;
}

const { token: tokenRef } = useAuthToken();
const token = tokenRef.value ?? "";

const { items: playlists, initialLoading, loadingMore, sentinel, loadMore, reset } = useInfiniteList<PlaylistRow>((page, limit) => {
  return token
    ? $fetch("/api/v1/playlist", { headers: { Authorization: token }, query: { page, limit } })
    : Promise.resolve({ items: [], page, limit, total: 0, hasMore: false });
});
await loadMore();

const { user: me, ensureLoaded: ensureUser } = useCurrentUser();
await ensureUser();

const { openMenu, openBulkMenu } = useMediaMenu();
const { selecting, selectedIds, count, isSelected, toggle, selectAll, clear, start, stop, retain } = useBulkSelect();

const subjectOf = (playlist: PlaylistRow) => ({
  kind: "playlist" as const,
  playlist: { id: playlist.id, title: playlist.title },
  isOwner: playlist.ownerId === me.value?.id,
  isMember: playlist.ownerId !== me.value?.id
});

function onChanged(change: MenuChange) {
  if (change.type === "deleted" || change.type === "left") {
    const gone = new Set(change.ids);
    playlists.value = playlists.value.filter((playlist) => !gone.has(playlist.id));
    retain(playlists.value.map((playlist) => playlist.id));
  }
}

function onCardClick(e: MouseEvent, playlist: PlaylistRow) {
  if (!selecting.value) return;
  e.preventDefault();
  toggle(playlist.id);
}

function onContextMenu(e: MouseEvent, playlist: PlaylistRow) {
  if (selecting.value) return;
  void openMenu(e, subjectOf(playlist), { onChanged });
}

function toggleAll() {
  if (count.value >= playlists.value.length) clear();
  else selectAll(playlists.value.map((playlist) => playlist.id));
}

function onBulkActions(e: MouseEvent) {
  const chosen = new Set(selectedIds.value);
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  void openBulkMenu({ x: rect.left, y: rect.top }, playlists.value.filter((playlist) => chosen.has(playlist.id)).map(subjectOf), { onChanged });
}

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
    await reset();
  } catch (e) {
    const err = apiErrorMessage(e, $t('settings.profile.error'));
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

.libplaylists .scroll-sentinel {
  height: 1px;
}

.libplaylists .loading-more {
  text-align: center;
  color: #666666;
  font-size: 0.8em;
  padding: 10px 0;
}

.libplaylists .grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 20px;
}

.libplaylists .pcard {
  position: relative;
  text-decoration: none;
}

.libplaylists .pcard.selected {
  outline: 3px solid #ffffff;
  outline-offset: 3px;
  border-radius: 8px;
}

.libplaylists .check {
  position: absolute;
  top: 8px;
  left: 8px;
  width: 26px;
  height: 26px;
  border-radius: 50%;
  border: 2px solid #ffffff;
  background: rgba(0, 0, 0, 0.55);
  color: #000000;
  display: flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-discy);
  font-size: 0.8em;
  font-weight: 700;
}

.libplaylists .check.on {
  background: #ffffff;
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
