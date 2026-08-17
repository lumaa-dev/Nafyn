<template>
  <Modal :model-value="modelValue" @update:model-value="emit('update:modelValue', $event)" :title="$t('playlist.addTracks.title')">
    <p v-if="availableTracks.length === 0" class="picker-empty">{{ $t('playlist.addTracks.empty') }}</p>
    <ul v-else class="plist">
      <li v-for="track in availableTracks" :key="track.id" @click="addTrack(track.id)">
        <img :src="track.coverArt ?? noCover" @error="($event.target as HTMLImageElement).src = noCover" loading="lazy" draggable="false" />
        <span class="col">
          <span class="title">{{ track.title }}</span>
          <span class="artist">{{ track.artistName }}</span>
        </span>
      </li>
    </ul>

    <button type="button" filled="hollow" @click="close">{{ $t('playlist.picker.cancel') }}</button>
  </Modal>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import noCover from '~/assets/no-cover.png';
import Modal from '~/components/Modal.vue';

const props = defineProps<{ modelValue: boolean; playlistId: string; existingMediaIds: string[] }>();
const emit = defineEmits<{ (e: "update:modelValue", value: boolean): void; (e: "added"): void }>();

const token = useCookie("nafynToken").value ?? "";
const libraryTracks = ref<MediaRow[]>([]);
const addedIds = ref<Set<string>>(new Set());

const availableTracks = computed(() => {
  const existing = new Set(props.existingMediaIds);
  return libraryTracks.value.filter((t) => !existing.has(t.id) && !addedIds.value.has(t.id));
});

watch(() => props.modelValue, async (isOpen) => {
  if (!isOpen) return;
  addedIds.value = new Set();
  libraryTracks.value = await $fetch<MediaRow[]>("/api/v1/library/tracks", { headers: { Authorization: token } }).catch(() => []);
});

async function addTrack(mediaId: string) {
  try {
    await $fetch(`/api/v1/playlist/${props.playlistId}/tracks`, {
      method: "POST",
      headers: { Authorization: token },
      body: { mediaIds: [mediaId] }
    });
    addedIds.value.add(mediaId);
    useToast().sendToast({ content: $t('playlist.addTracks.added'), tint: "green", icon: null, title: null });
    emit("added");
  } catch (e) {
    const err = (e as { data?: { statusMessage?: string; }; })?.data?.statusMessage ?? $t('playlist.addTracks.error');
    useToast().sendToast({ content: err, tint: "red", icon: null, title: null });
  }
}

function close() {
  emit("update:modelValue", false);
}
</script>

<style>
.plist .col {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.plist .title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.plist .artist {
  font-size: 0.85em;
  color: #666666;
}
</style>
