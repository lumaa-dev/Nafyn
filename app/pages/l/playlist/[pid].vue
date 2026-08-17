<template>
  <div class="playlistpage" v-if="detail">
    <div class="header">
      <div class="cover-field">
        <img
          class="cover"
          :src="coverUrl"
          @error="($event.target as HTMLImageElement).src = noCover"
          draggable="false"
          @click="viewer.isOwner ? avatarInput?.click() : undefined"
          :class="{ editable: viewer.isOwner }"
        />
        <input v-if="viewer.isOwner" ref="avatarInput" type="file" accept="image/png,image/jpeg,image/webp" class="hidden-input" @change="onImageSelected">
      </div>

      <div class="meta">
        <span class="privacy">{{ $t(`playlist.privacy.${detail.playlist.privacy}`) }}</span>
        <h1>{{ detail.playlist.title }}</h1>
        <p v-if="detail.playlist.description" class="description">{{ detail.playlist.description }}</p>
        <p class="owner" v-if="detail.members.length > 0">{{ $t('playlist.ownedBy', { name: detail.owner?.displayName ?? detail.owner?.username }) }}</p>

        <div class="actions">
          <button type="button" filled :disabled="!viewer.userId || tracks.length === 0" @click="playAll">{{ $t('playlist.play') }}</button>
          <button type="button" filled :disabled="!viewer.userId || tracks.length === 0" @click="shuffleAll">{{ $t('playlist.shuffle') }}</button>
        </div>
        <div class="actions">
          <button v-if="viewer.isMember || viewer.isOwner" type="button" class="iconbtn" @click="showAddTracks = true" :title="$t('playlist.addTracks.open')" :aria-label="$t('playlist.addTracks.open')">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button v-if="viewer.isOwner" type="button" class="iconbtn" @click="showEdit = true" :title="$t('playlist.edit.open')" :aria-label="$t('playlist.edit.open')">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
          </button>
          <button v-if="viewer.isOwner" type="button" class="iconbtn" @click="showMembers = true" :title="$t('playlist.members.open')" :aria-label="$t('playlist.members.open')">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></svg>
          </button>
          <button v-if="viewer.isOwner" type="button" class="iconbtn danger" @click="confirmDelete = true" :title="$t('playlist.delete.open')" :aria-label="$t('playlist.delete.open')">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></svg>
          </button>
          <button v-else-if="viewer.isMember" type="button" class="leavebtn danger" @click="leave" :title="$t('playlist.leave')" :aria-label="$t('playlist.leave')">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </div>
    </div>

    <div class="sortbar">
      <label for="sort">{{ $t('playlist.sort.label') }}</label>
      <select id="sort" v-model="sortMode" :disabled="!viewer.userId || tracks.length === 0">
        <option value="manual">{{ $t('playlist.sort.manual') }}</option>
        <option value="title">{{ $t('playlist.sort.title') }}</option>
        <option value="artist">{{ $t('playlist.sort.artist') }}</option>
        <option value="addedBy">{{ $t('playlist.sort.addedBy') }}</option>
        <option value="duration">{{ $t('playlist.sort.duration') }}</option>
      </select>
    </div>

    <ol class="tracks" v-if="displayEntries.length > 0" ref="tracksListEl">
      <li
        v-for="(entry, i) in displayEntries"
        :key="entry.entryId"
        :data-entry-index="i"
        :class="{ playing: currentTrack?.id === entry.media.id, dragging: draggingIndex === i }"
        @contextmenu.prevent="onRowContextMenu($event, entry)"
      >
        <button
          v-if="viewer.isOwner && sortMode === 'manual'"
          type="button"
          :class="{ draghandle: true, grabbing: draggingIndex === i }"
          :aria-label="$t('playlist.reorder')"
          @pointerdown.prevent="onHandlePointerDown($event, i)"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><circle cx="9" cy="6" r="1.5" /><circle cx="15" cy="6" r="1.5" /><circle cx="9" cy="12" r="1.5" /><circle cx="15" cy="12" r="1.5" /><circle cx="9" cy="18" r="1.5" /><circle cx="15" cy="18" r="1.5" /></svg>
        </button>

        <img :src="entry.media.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" @click="playFrom(i)" />
        <span class="col" @click="playFrom(i)">
          <span class="title">{{ entry.media.title }}</span>
          <span class="artist">{{ entry.media.artistName }}</span>
        </span>
        <span class="addedBy" v-if="detail.members.length > 0">{{ entry.addedBy?.displayName ?? entry.addedBy?.username }}</span>
        <span class="duration">{{ formatDuration(entry.media.duration) }}</span>

        <button type="button" class="ellipsis" @click.stop="onRowEllipsis($event, entry)" :aria-label="$t('playlist.removeTrack')" v-if="viewer.userId">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><circle cx="12" cy="5" r="2" /><circle cx="12" cy="12" r="2" /><circle cx="12" cy="19" r="2" /></svg>
        </button>
      </li>
    </ol>
    <p class="empty" v-else>{{ $t('playlist.tracksEmpty') }}</p>

    <ContextMenu ref="rowMenu" :items="rowMenuItems" v-if="viewer.userId" />
    <AddTracksModal v-model="showAddTracks" :playlist-id="pid" :existing-media-ids="tracks.map((t) => t.id)" @added="refresh" />

    <Modal v-model="showEdit" :title="$t('playlist.edit.open')">
      <div class="modalform">
        <label for="etitle">{{ $t('playlist.form.title') }}</label>
        <input id="etitle" v-model="editTitle" type="text" maxlength="100">

        <label for="edescription">{{ $t('playlist.form.description') }}</label>
        <textarea id="edescription" v-model="editDescription" maxlength="500" rows="3" />

        <label for="eprivacy">{{ $t('playlist.form.privacy') }}</label>
        <select id="eprivacy" v-model="editPrivacy">
          <option value="private">{{ $t('playlist.privacy.private') }}</option>
          <option value="public">{{ $t('playlist.privacy.public') }}</option>
        </select>

        <button type="button" filled :disabled="!editTitle.trim()" @click="saveEdit">{{ $t('playlist.edit.save') }}</button>
        <button type="button" filled="hollow" @click="showEdit = false">{{ $t('playlist.picker.cancel') }}</button>
      </div>
    </Modal>

    <Modal v-model="showMembers" :title="$t('playlist.members.open')">
      <div class="modalform">
        <ul class="memberlist">
          <li v-for="member in detail.members" :key="member.id">
            <span>{{ member.displayName ?? member.username }}</span>
            <button type="button" filled="hollow" class="danger" @click="removeMember(member.id)">{{ $t('playlist.members.remove') }}</button>
          </li>
        </ul>

        <label for="inviteName">{{ $t('playlist.members.inviteLabel') }}</label>
        <input id="inviteName" v-model="inviteUsername" type="text" :placeholder="$t('playlist.members.invitePlaceholder')">
        <button type="button" filled :disabled="!inviteUsername.trim()" @click="invite">{{ $t('playlist.members.invite') }}</button>
        <button type="button" filled="hollow" @click="showMembers = false">{{ $t('playlist.picker.cancel') }}</button>
      </div>
    </Modal>

    <Modal v-model="confirmDelete" :title="$t('playlist.delete.confirmTitle')">
      <div class="modalform">
        <p>{{ $t('playlist.delete.confirmMessage') }}</p>
        <button type="button" filled class="danger" @click="deletePlaylist">{{ $t('playlist.delete.open') }}</button>
        <button type="button" filled="hollow" @click="confirmDelete = false">{{ $t('playlist.picker.cancel') }}</button>
      </div>
    </Modal>
  </div>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import noCover from '~/assets/no-cover.png';
import ContextMenu, { type ContextMenuItem } from '~/components/ContextMenu.vue';
import AddTracksModal from '~/components/AddTracksModal.vue';
import Modal from '~/components/Modal.vue';

interface CompactUser {
  id: string;
  username: string;
  displayName: string | null;
}

interface PlaylistDetail {
  playlist: {
    id: string;
    title: string;
    description: string | null;
    privacy: "public" | "private";
    image: string | null;
    sortMode: "manual" | "title" | "artist" | "addedBy" | "duration";
  };
  owner: CompactUser | null;
  members: CompactUser[];
  entries: {
    entryId: string;
    addedBy: CompactUser | null;
    position: number;
    addedAt: number;
    media: MediaRow;
  }[];
  viewer: { userId: string | null; isOwner: boolean; isMember: boolean };
}

const route = useRoute();
const pid = route.params.pid as string;
const token = useCookie("nafynToken").value ?? "";

const { data: detail, refresh } = await useAsyncData<PlaylistDetail | null>(`playlist-${pid}`, () => {
  return $fetch(`/api/v1/playlist/${pid}`, { headers: token ? { Authorization: token } : {} }).catch(() => null);
});

const viewer = computed(() => detail.value?.viewer ?? { userId: null, isOwner: false, isMember: false });
const tracks = computed<MediaRow[]>(() => detail.value?.entries.map((e) => e.media) ?? []);

type SortMode = "manual" | "title" | "artist" | "addedBy" | "duration";

// sortMode is a shared playlist setting persisted server-side (server/core/playlists.ts),
// so it stays consistent across devices and for every member, not just the local browser
const sortMode = ref<SortMode>("manual");
let suppressSortPatch = false;

watch(() => detail.value?.playlist.sortMode, (mode) => {
  if (!mode) return;
  suppressSortPatch = true;
  sortMode.value = mode;
  nextTick(() => { suppressSortPatch = false; });
}, { immediate: true });

watch(sortMode, async (mode) => {
  if (suppressSortPatch) return;
  try {
    await $fetch(`/api/v1/playlist/${pid}`, {
      method: "PATCH",
      headers: { Authorization: token },
      body: { sortMode: mode }
    });
  } catch (e) {
    sendError(e);
  }
});

const sortedEntries = computed(() => {
  const entries = detail.value?.entries ?? [];
  if (sortMode.value === "manual") return entries;

  const copy = [...entries];
  switch (sortMode.value) {
    case "title": return copy.sort((a, b) => a.media.title.localeCompare(b.media.title));
    case "artist": return copy.sort((a, b) => a.media.artistName.localeCompare(b.media.artistName));
    case "addedBy": return copy.sort((a, b) => (a.addedBy?.username ?? "").localeCompare(b.addedBy?.username ?? ""));
    case "duration": return copy.sort((a, b) => a.media.duration - b.media.duration);
    default: return copy;
  }
});

// manual order is mirrored into a local, mutable array so drag-and-drop can
// reorder it live before the server confirms the persisted order
const dragEntries = ref<PlaylistDetail["entries"]>([]);
watch(() => detail.value?.entries, (entries) => {
  dragEntries.value = entries ? [...entries] : [];
}, { immediate: true });

const displayEntries = computed(() => sortMode.value === "manual" ? dragEntries.value : sortedEntries.value);

const coverUrl = computed(() => {
  const img = detail.value?.playlist.image;
  return img ? `/api/v1/playlist/${pid}/image?token=${encodeURIComponent(token)}&v=${img}` : noCover;
});

const { currentTrack, play } = usePlayer();

function playAll() {
  const ordered = displayEntries.value.map((e) => e.media);
  if (ordered.length === 0) return;
  play(ordered[0]!, ordered, { type: "playlist", refId: pid });
}

function playFrom(index: number) {
  if (!viewer.value.userId) return;
  const track = displayEntries.value[index]?.media;
  if (track) play(track, displayEntries.value.map((e) => e.media), { type: "playlist", refId: pid });
}

function shuffleAll() {
  const ordered = displayEntries.value.map((e) => e.media);
  if (ordered.length === 0) return;
  const shuffled = [...ordered].sort(() => Math.random() - 0.5);
  play(shuffled[0]!, shuffled, { type: "playlist", refId: pid });
}

function formatDuration(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

// add tracks
const showAddTracks = ref(false);

// context menu / row actions
const rowMenu = ref<InstanceType<typeof ContextMenu> | null>(null);
const rowMenuItems = ref<ContextMenuItem[]>([]);

function canRemove(entry: PlaylistDetail["entries"][number]): boolean {
  return viewer.value.isOwner || entry.addedBy?.id === viewer.value.userId;
}

function buildRowMenu(entry: PlaylistDetail["entries"][number]) {
  const items: ContextMenuItem[] = [];
  if (canRemove(entry)) {
    items.push({ label: $t('playlist.removeTrack'), danger: true, action: () => removeEntry(entry.entryId) });
  }
  rowMenuItems.value = items;
}

function onRowContextMenu(e: MouseEvent, entry: PlaylistDetail["entries"][number]) {
  buildRowMenu(entry);
  rowMenu.value?.openAt(e.clientX, e.clientY);
}

function onRowEllipsis(e: MouseEvent, entry: PlaylistDetail["entries"][number]) {
  buildRowMenu(entry);
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  rowMenu.value?.openAt(rect.left, rect.bottom);
}

async function removeEntry(entryId: string) {
  try {
    await $fetch(`/api/v1/playlist/${pid}/tracks/${entryId}`, { method: "DELETE", headers: { Authorization: token } });
    await refresh();
  } catch (e) {
    sendError(e);
  }
}

async function persistOrder(entries: PlaylistDetail["entries"]) {
  try {
    await $fetch(`/api/v1/playlist/${pid}/order`, {
      method: "POST",
      headers: { Authorization: token },
      body: { order: entries.map((e) => e.entryId) }
    });
    await refresh();
  } catch (e) {
    sendError(e);
    dragEntries.value = detail.value ? [...detail.value.entries] : [];
  }
}

// drag-and-drop reorder (pointer events cover mouse drag and touch drag alike)
const draggingIndex = ref<number | null>(null);

function onHandlePointerDown(_e: PointerEvent, index: number) {
  if (!viewer.value.isOwner || sortMode.value !== "manual") return;

  draggingIndex.value = index;
  window.addEventListener("pointermove", onDragPointerMove);
  window.addEventListener("pointerup", onDragPointerUp);
  window.addEventListener("pointercancel", onDragPointerUp);

  window.document.body.style = "cursor: grabbing !important;"
}

function onDragPointerMove(e: PointerEvent) {
  if (draggingIndex.value === null) return;
  const el = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
  const li = el?.closest("li[data-entry-index]") as HTMLElement | null;
  if (!li) return;

  const overIndex = Number(li.dataset.entryIndex);
  if (Number.isNaN(overIndex) || overIndex === draggingIndex.value) return;

  const entries = dragEntries.value;
  const [moved] = entries.splice(draggingIndex.value, 1);
  entries.splice(overIndex, 0, moved!);
  draggingIndex.value = overIndex;
}

function onDragPointerUp() {
  window.removeEventListener("pointermove", onDragPointerMove);
  window.removeEventListener("pointerup", onDragPointerUp);
  window.removeEventListener("pointercancel", onDragPointerUp);
  if (draggingIndex.value !== null) {
    draggingIndex.value = null;
    persistOrder(dragEntries.value);
  }

  window.document.body.style = ""
}

onUnmounted(() => {
  window.removeEventListener("pointermove", onDragPointerMove);
  window.removeEventListener("pointerup", onDragPointerUp);
  window.removeEventListener("pointercancel", onDragPointerUp);
});

// cover image
const avatarInput = ref<HTMLInputElement | null>(null);

async function onImageSelected(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;

  const body = new FormData();
  body.append("image", file);

  try {
    await $fetch(`/api/v1/playlist/${pid}/image`, { method: "POST", headers: { Authorization: token }, body });
    await refresh();
  } catch (e) {
    sendError(e);
  }
}

// edit modal
const showEdit = ref(false);
const editTitle = ref("");
const editDescription = ref("");
const editPrivacy = ref<"public" | "private">("private");

watch(showEdit, (open) => {
  if (!open || !detail.value) return;
  editTitle.value = detail.value.playlist.title;
  editDescription.value = detail.value.playlist.description ?? "";
  editPrivacy.value = detail.value.playlist.privacy;
});

async function saveEdit() {
  try {
    await $fetch(`/api/v1/playlist/${pid}`, {
      method: "PATCH",
      headers: { Authorization: token },
      body: { title: editTitle.value.trim(), description: editDescription.value.trim(), privacy: editPrivacy.value }
    });
    showEdit.value = false;
    await refresh();
  } catch (e) {
    sendError(e);
  }
}

// members modal
const showMembers = ref(false);
const inviteUsername = ref("");

async function invite() {
  try {
    await $fetch(`/api/v1/playlist/${pid}/members`, {
      method: "POST",
      headers: { Authorization: token },
      body: { username: inviteUsername.value.trim() }
    });
    inviteUsername.value = "";
    await refresh();
  } catch (e) {
    sendError(e);
  }
}

async function removeMember(userId: string) {
  try {
    await $fetch(`/api/v1/playlist/${pid}/members/${userId}`, { method: "DELETE", headers: { Authorization: token } });
    await refresh();
  } catch (e) {
    sendError(e);
  }
}

async function leave() {
  try {
    await $fetch(`/api/v1/playlist/${pid}/leave`, { method: "POST", headers: { Authorization: token } });
    await navigateTo("/l/playlists");
  } catch (e) {
    sendError(e);
  }
}

// delete
const confirmDelete = ref(false);

async function deletePlaylist() {
  try {
    await $fetch(`/api/v1/playlist/${pid}`, { method: "DELETE", headers: { Authorization: token } });
    await navigateTo("/l/playlists");
  } catch (e) {
    sendError(e);
  }
}

function sendError(e: unknown) {
  const err = (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? $t('settings.profile.error');
  useToast().sendToast({ content: err, tint: "red", icon: null, title: null });
}
</script>

<style>
.playlistpage {
  width: 70vw;
  max-width: 1200px;
  margin: calc(15vh - 10px) auto;
}

.playlistpage .header {
  display: flex;
  gap: 30px;
  margin-bottom: 30px;
}

.playlistpage .cover {
  width: 220px;
  height: 220px;
  border-radius: 10px;
  object-fit: cover;
  background: #00000040;
  flex-shrink: 0;
}

.playlistpage .cover.editable {
  cursor: pointer;
}

.playlistpage .hidden-input {
  display: none;
}

.playlistpage .meta {
  display: flex;
  flex-direction: column;
  gap: 6px;
  justify-content: flex-end;
}

.playlistpage .privacy {
  font-size: 0.75em;
  text-transform: uppercase;
  color: #666666;
}

.playlistpage .description {
  color: #999999;
}

.playlistpage .owner {
  font-size: 0.85em;
  color: #666666;
}

.playlistpage .actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
  flex-wrap: wrap;
}

.playlistpage .actions .iconbtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid #ffffffae;
  background: none;
  color: #ffffff;
  cursor: pointer;
}

.playlistpage .actions .iconbtn:hover {
  background: #ffffff1a;
}

.playlistpage .actions .iconbtn.danger {
  color: #e06666;
  border: 1px solid #e06666ae;
}

.playlistpage .actions .leavebtn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 38px;
  padding: 0;
  border-radius: 12px;
  border: 1px solid #333333;
  background: none;
  color: #e06666;
  cursor: pointer;
}

.playlistpage .actions .leavebtn:hover {
  background: #ffffff1a;
}

.playlistpage .sortbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  font-size: 0.85em;
}

.playlistpage .empty {
  color: #666666;
}

.playlistpage .tracks {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
}

.playlistpage .tracks li {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 15px;
  padding: 10px 0;
}

.playlistpage .tracks li.playing .title {
  color: #ffffff;
  font-weight: 700;
}

.playlistpage .tracks li:not(:last-child) {
  border-bottom: 1px solid #666666;
}

.playlistpage .tracks li.dragging {
  opacity: 0.5;
}

.playlistpage .draghandle {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: none;
  border: none;
  color: #666666;
  cursor: grab;
  touch-action: none;
  padding: 4px;
}

.playlistpage .draghandle.grabbing {
  cursor: grabbing;
}

.playlistpage .tracks img {
  width: 45px;
  height: 45px;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  background: #00000040;
  cursor: pointer;
}

.playlistpage .tracks .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
  cursor: pointer;
}

.playlistpage .tracks .title, .playlistpage .tracks .addedBy {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.playlistpage .tracks .artist {
  font-size: 0.85em;
  color: #666666;
}

.playlistpage .tracks .addedBy {
  max-width: 150px;
  font-size: 0.85em;
  color: #666666;
}

.playlistpage .tracks .duration {
  color: #666666;
  font-variant-numeric: tabular-nums;
  font-size: 0.7em;
}

.playlistpage .ellipsis {
  display: flex;
  align-items: center;
  justify-content: center;
  background: none;
  border: none;
  color: #666666;
  cursor: pointer;
  padding: 4px;
}

.modalform {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.modalform label {
  font-size: 0.7em;
  color: #666666;
}

.modalform .danger {
  color: #e06666;
}

.modalform .memberlist {
  list-style: none;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.modalform .memberlist li {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

@media screen and (max-width: 800px) {
  .playlistpage {
    width: 90%;
  }

  .playlistpage .header {
    flex-direction: column;
  }

  .playlistpage .cover-field {
    display: flex;
    justify-content: center;
    width: 100%;
  }

  .playlistpage .cover {
    width: 75%;
    height: auto;
    aspect-ratio: 1 / 1;
  }

  .playlistpage .actions {
    justify-content: space-between;
    gap: 0;
  }

  .playlistpage .actions button {
    padding: 0.6em 0;
    width: calc(50% - 3.5px);
  }

  .playlistpage .tracks .addedBy {
    display: none;
  }
}
</style>
