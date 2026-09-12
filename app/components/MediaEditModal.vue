<template>
  <Modal v-model="open" :title="$t('edit.title')">
    <form class="media-edit" @submit.prevent="save">
      <label class="cover-field">
        <img :src="coverPreview" @error="($event.target as HTMLImageElement).src = noCoverImage" draggable="false" />
        <span>{{ $t('edit.changeCover') }}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" @change="onCoverPick" />
      </label>
      <button v-if="hasCover" type="button" class="link" @click="removeCover">{{ $t('edit.removeCover') }}</button>

      <label>{{ $t('edit.trackTitle') }}<input v-model="form.title" type="text" required maxlength="500" /></label>
      <label>{{ $t('edit.artist') }}<input v-model="form.artistName" type="text" required maxlength="500" /></label>
      <label>{{ $t('edit.album') }}<input v-model="form.album" type="text" maxlength="500" /></label>

      <label>{{ $t('edit.albumType') }}
        <select v-model="form.albumType">
          <option value="">{{ $t('edit.none') }}</option>
          <option value="album">{{ $t('edit.typeAlbum') }}</option>
          <option value="ep">{{ $t('edit.typeEp') }}</option>
        </select>
      </label>

      <label>{{ $t('edit.trackNumber') }}<input v-model="form.trackNumber" type="number" min="1" step="1" /></label>
      <label>{{ $t('edit.releaseDate') }}<input v-model="form.releaseDate" type="date" /></label>
      <label>{{ $t('edit.label') }}<input v-model="form.label" type="text" maxlength="500" /></label>
      <label>{{ $t('edit.duration') }}<input v-model="form.duration" type="text" placeholder="3:45" /></label>

      <label>{{ $t('edit.lyricsFormat') }}
        <select v-model="form.lyricsFormat">
          <option value="plain">{{ $t('edit.lyricsPlain') }}</option>
          <option value="lrc">{{ $t('edit.lyricsLrc') }}</option>
        </select>
      </label>
      <label class="lyrics">{{ $t('edit.lyrics') }}
        <textarea v-model="form.lyrics" rows="8" :placeholder="$t('edit.lyricsPlaceholder')" />
      </label>

      <div class="actions">
        <button type="button" filled="hollow" @click="open = false">{{ $t('common.cancel') }}</button>
        <button type="submit" filled :disabled="saving">{{ saving ? $t('edit.saving') : $t('edit.save') }}</button>
      </div>
    </form>
  </Modal>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import Modal from '~/components/Modal.vue';

const props = defineProps<{ modelValue: boolean, media: MediaRow | null }>();
const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void,
  (e: "saved", media: MediaRow): void
}>();

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value)
});

const token = useCookie("nafynToken").value;
const { sendToast } = useToast();

const form = reactive({
  title: "",
  artistName: "",
  album: "",
  albumType: "" as "" | "album" | "ep",
  trackNumber: "" as number | string,
  releaseDate: "",
  label: "",
  duration: "",
  lyrics: "",
  lyricsFormat: "plain" as "plain" | "lrc"
});

const saving = ref(false);
const coverFile = ref<File | null>(null);
const coverObjectUrl = ref<string | null>(null);
// bumped after every cover write so the <img> refetches instead of showing the browser-cached old one
const coverVersion = ref(0);
// lyrics as they were when the form opened, so an untouched field never rewrites (or deletes) what's stored
const originalLyrics = ref("");

const hasCover = computed(() => !!props.media?.hasCustomCover || !!coverFile.value);
const coverPreview = computed(() => coverObjectUrl.value ?? coverSrcFresh(props.media, coverVersion.value));

function secondsToClock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${Math.floor(seconds % 60).toString().padStart(2, "0")}`;
}

// accepts "3:45", "225" or "1:02:03" - a plain seconds count stays valid so the field is never a trap
function clockToSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;

  return parts.reduce((total, part) => total * 60 + part, 0);
}

async function loadForm() {
  const media = props.media;
  if (!media) return;

  form.title = media.title;
  form.artistName = media.artistName;
  form.album = media.album ?? "";
  form.albumType = media.albumType ?? "";
  form.trackNumber = media.trackNumber ?? "";
  form.releaseDate = media.releaseDate ? new Date(media.releaseDate * 1000).toISOString().slice(0, 10) : "";
  form.label = media.label ?? "";
  form.duration = media.duration ? secondsToClock(media.duration) : "";
  coverFile.value = null;
  coverObjectUrl.value = null;

  const stored = await $fetch<{ format: "plain" | "lrc", content: string } | null>(
    `/api/v1/library/${media.id}/lyrics`,
    { headers: { Authorization: token ?? "" }, query: { source: 1 } }
  ).catch(() => null);

  form.lyrics = stored?.content ?? "";
  form.lyricsFormat = stored?.format ?? "plain";
  originalLyrics.value = form.lyrics;
}

watch(() => [props.modelValue, props.media?.id], () => {
  if (props.modelValue) loadForm();
});

function onCoverPick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null;
  coverFile.value = file;
  coverObjectUrl.value = file ? URL.createObjectURL(file) : null;
}

async function removeCover() {
  if (!props.media || !token) return;

  coverFile.value = null;
  coverObjectUrl.value = null;
  if (!props.media.hasCustomCover) return;

  await $fetch(`/api/v1/library/${props.media.id}/cover`, { method: "DELETE", headers: { Authorization: token } })
    .catch(() => sendToast({ title: null, content: $t('edit.coverError'), icon: null, tint: "red" }));
  coverVersion.value++;
}

async function save() {
  const media = props.media;
  if (!media || !token) return;

  saving.value = true;
  try {
    const duration = clockToSeconds(form.duration);
    const trackNumber = form.trackNumber === "" ? null : Number(form.trackNumber);

    const updated = await $fetch<MediaRow>(`/api/v1/library/${media.id}`, {
      method: "PATCH",
      headers: { Authorization: token },
      body: {
        title: form.title,
        artistName: form.artistName,
        album: form.album.trim() || null,
        albumType: form.albumType || null,
        trackNumber: trackNumber && trackNumber > 0 ? trackNumber : null,
        releaseDate: form.releaseDate ? Math.floor(new Date(`${form.releaseDate}T00:00:00Z`).getTime() / 1000) : null,
        label: form.label.trim() || null,
        ...(duration && duration > 0 ? { duration } : {})
      }
    });

    if (coverFile.value) {
      const body = new FormData();
      body.append("cover", coverFile.value);
      await $fetch(`/api/v1/library/${media.id}/cover`, { method: "PUT", headers: { Authorization: token }, body });
      updated.hasCustomCover = 1;
      coverVersion.value++;
    }

    // only touch stored lyrics when the field actually changed, so opening the dialog to fix a typo in the
    // title never wipes lyrics that came from a provider or were entered earlier
    if (form.lyrics !== originalLyrics.value) {
      if (form.lyrics.trim().length > 0) {
        await $fetch(`/api/v1/library/${media.id}/lyrics`, {
          method: "PUT",
          headers: { Authorization: token },
          body: { content: form.lyrics, format: form.lyricsFormat }
        });
      } else {
        await $fetch(`/api/v1/library/${media.id}/lyrics`, { method: "DELETE", headers: { Authorization: token } });
      }
      originalLyrics.value = form.lyrics;
    }

    sendToast({ title: updated.title, content: $t('edit.saved'), icon: null, tint: "green" });
    emit("saved", updated);
    open.value = false;
  } catch (e) {
    const message = (e as { data?: { statusMessage?: string } })?.data?.statusMessage ?? $t('edit.error');
    sendToast({ title: null, content: message, icon: null, tint: "red" });
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.media-edit {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.media-edit label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85em;
  color: #666666;
}

.media-edit input[type="text"],
.media-edit input[type="number"],
.media-edit input[type="date"],
.media-edit select,
.media-edit textarea {
  background: #00000040;
  border: 1px solid #666666;
  border-radius: 8px;
  padding: 8px;
  color: inherit;
  font: inherit;
  width: 100%;
}

.media-edit textarea {
  resize: vertical;
  min-height: 120px;
}

.media-edit .cover-field {
  align-items: center;
  cursor: pointer;
}

.media-edit .cover-field img {
  width: 140px;
  height: 140px;
  border-radius: 10px;
  object-fit: cover;
  background: #00000040;
}

.media-edit .cover-field input[type="file"] {
  display: none;
}

.media-edit .link {
  background: none;
  border: none;
  color: #666666;
  cursor: pointer;
  font-size: 0.8em;
  text-decoration: underline;
  width: fit-content;
  align-self: center;
}

.media-edit .actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}
</style>
