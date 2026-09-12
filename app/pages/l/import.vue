<template>
  <div class="import">
    <h1>{{ $t('import.title') }}</h1>
    <p class="hint">{{ $t('import.hint') }}</p>

    <form @submit.prevent="submit">
      <label class="file-field">
        <span>{{ audioFile ? audioFile.name : $t('import.pickFile') }}</span>
        <input type="file" accept=".mp3,.flac,.ogg,.wav,audio/*" required @change="onAudioPick" />
      </label>

      <label class="cover-field">
        <img :src="coverPreview" draggable="false" />
        <span>{{ $t('import.pickCover') }}</span>
        <input type="file" accept="image/png,image/jpeg,image/webp" @change="onCoverPick" />
      </label>

      <label>{{ $t('edit.trackTitle') }}<input v-model="form.title" type="text" maxlength="500" :placeholder="$t('import.fromFile')" /></label>
      <label>{{ $t('edit.artist') }}<input v-model="form.artist" type="text" maxlength="500" :placeholder="$t('import.fromFile')" /></label>
      <label>{{ $t('edit.album') }}<input v-model="form.album" type="text" maxlength="500" :placeholder="$t('import.fromFile')" /></label>

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
      <label>{{ $t('edit.duration') }}<input v-model="form.duration" type="text" :placeholder="$t('import.durationHint')" /></label>

      <label>{{ $t('edit.lyricsFormat') }}
        <select v-model="form.lyricsFormat">
          <option value="plain">{{ $t('edit.lyricsPlain') }}</option>
          <option value="lrc">{{ $t('edit.lyricsLrc') }}</option>
        </select>
      </label>
      <label>{{ $t('edit.lyrics') }}<textarea v-model="form.lyrics" rows="8" :placeholder="$t('edit.lyricsPlaceholder')" /></label>

      <button type="submit" filled :disabled="importing || !audioFile">
        {{ importing ? $t('import.importing') : $t('import.submit') }}
      </button>
    </form>
  </div>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';

const token = useCookie("nafynToken").value;
const { sendToast } = useToast();

const audioFile = ref<File | null>(null);
const coverFile = ref<File | null>(null);
const coverObjectUrl = ref<string | null>(null);
const importing = ref(false);

const coverPreview = computed(() => coverObjectUrl.value ?? noCoverImage);

const form = reactive({
  title: "",
  artist: "",
  album: "",
  albumType: "" as "" | "album" | "ep",
  trackNumber: "" as number | string,
  releaseDate: "",
  label: "",
  duration: "",
  lyrics: "",
  lyricsFormat: "plain" as "plain" | "lrc"
});

function onAudioPick(event: Event) {
  audioFile.value = (event.target as HTMLInputElement).files?.[0] ?? null;
}

function onCoverPick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null;
  coverFile.value = file;
  coverObjectUrl.value = file ? URL.createObjectURL(file) : null;
}

// "3:45", "225" and "1:02:03" all work; blank means "whatever the file itself says"
function clockToSeconds(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parts = trimmed.split(":").map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) return null;

  return parts.reduce((total, part) => total * 60 + part, 0);
}

async function submit() {
  if (!audioFile.value || !token) return;

  importing.value = true;
  try {
    const duration = clockToSeconds(form.duration);
    const body = new FormData();
    body.append("audio", audioFile.value);
    if (coverFile.value) body.append("cover", coverFile.value);
    body.append("metadata", JSON.stringify({
      title: form.title || null,
      artist: form.artist || null,
      album: form.album || null,
      albumType: form.albumType || null,
      trackNumber: form.trackNumber === "" ? null : Number(form.trackNumber),
      releaseDate: form.releaseDate || null,
      label: form.label || null,
      duration,
      lyrics: form.lyrics || null,
      lyricsFormat: form.lyricsFormat
    }));

    const media = await $fetch<MediaRow>("/api/v1/library/import", {
      method: "POST",
      headers: { Authorization: token },
      body
    });

    sendToast({ title: media.title, content: $t('import.done'), icon: null, tint: "green" });
    await navigateTo(`/l/t/${media.id}`);
  } catch (e) {
    const message = (e as { data?: { statusMessage?: string } })?.data?.statusMessage ?? $t('import.error');
    sendToast({ title: null, content: message, icon: null, tint: "red" });
  } finally {
    importing.value = false;
  }
}
</script>

<style scoped>
.import {
  max-width: 600px;
  margin: calc(15vh - 10px) auto;
  padding: 0 1.2em;
}

.import .hint {
  color: #666666;
  font-size: 0.85em;
  margin-bottom: 1.5em;
}

.import form {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.import label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 0.85em;
  color: #666666;
}

.import input[type="text"],
.import input[type="number"],
.import input[type="date"],
.import select,
.import textarea {
  background: #00000040;
  border: 1px solid #666666;
  border-radius: 8px;
  padding: 10px;
  color: inherit;
  font: inherit;
}

.import textarea {
  resize: vertical;
}

.import .file-field,
.import .cover-field {
  align-items: center;
  border: 1px dashed #666666;
  border-radius: 12px;
  padding: 16px;
  cursor: pointer;
  text-align: center;
}

.import .file-field input[type="file"],
.import .cover-field input[type="file"] {
  display: none;
}

.import .cover-field img {
  width: 140px;
  height: 140px;
  border-radius: 10px;
  object-fit: cover;
  background: #00000040;
}

.import button[type="submit"] {
  align-self: flex-start;
}
</style>
