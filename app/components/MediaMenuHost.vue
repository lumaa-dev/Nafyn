<template>
  <ContextMenu ref="menu" :items="host.items" />
  <PlaylistPickerModal v-model="host.picker.open" :media-ids="host.picker.mediaIds" :admin="host.picker.admin" />
  <MediaEditModal v-model="host.edit.open" :targets="host.edit.targets" @saved="onSaved" />
</template>

<script lang="ts" setup>
// Renders the context menu, the playlist picker and the metadata editor that useMediaMenu() drives. Mounted once
// (app.vue), so every page shares them - and so every page offers the same actions.
import ContextMenu from '~/components/ContextMenu.vue';
import PlaylistPickerModal from '~/components/PlaylistPickerModal.vue';
import MediaEditModal from '~/components/MediaEditModal.vue';
import type { MediaRow } from '~~/server/core/library';

const host = useMediaMenuHost();
const pins = usePins();

// the pin state the menus show; loaded up front so the first right click already knows it
onMounted(() => { void pins.ensureLoaded(); });
const menu = ref<InstanceType<typeof ContextMenu> | null>(null);

watch(() => host.anchor.seq, () => {
  menu.value?.openAt(host.anchor.x, host.anchor.y);
});

function onSaved(rows: MediaRow[]) {
  host.onEdited?.(rows);
}
</script>
