<template>
  <Modal v-model="open" :title="isBulk ? $t('edit.titleMany', { count: list.length }) : $t('edit.title')">
    <form class="media-edit" @submit.prevent="save">
      <div class="cover-field">
        <img :src="coverPreview" @error="($event.target as HTMLImageElement).src = noCoverImage" draggable="false" />
        <button type="button" class="change-cover" :aria-expanded="showCovers" @click="toggleCovers">{{ $t('edit.changeCover') }}</button>
        <input ref="fileInput" type="file" accept="image/png,image/jpeg,image/webp" hidden @change="onCoverPick" />
      </div>

      <!-- alternatives from the album's MusicBrainz release-group, next to uploading a picture of one's own -->
      <div v-if="showCovers" class="cover-gallery" role="group" :aria-label="$t('edit.changeCover')">
        <p v-if="loadingCovers" class="hint">{{ $t('edit.coversLoading') }}</p>
        <ul>
          <li>
            <button type="button" class="tile upload" :class="{ selected: !!coverFile }" :aria-pressed="!!coverFile" @click="fileInput?.click()">
              <span class="plus" aria-hidden="true">+</span>
              <span class="name">{{ $t('edit.uploadCover') }}</span>
            </button>
          </li>
          <li v-for="option in coverOptions" :key="`${option.kind}-${option.id}`">
            <button type="button" class="tile" :class="{ selected: selectedCover?.id === option.id }" :aria-pressed="selectedCover?.id === option.id" @click="selectCover(option)">
              <CoverImage :src="coverArtUrl(option.url, 250)" />
              <span class="name">{{ option.kind === 'release-group' ? $t('edit.coverGroup') : option.title }}</span>
              <span v-if="option.details" class="details">{{ option.details }}</span>
              <span v-if="isCurrentCover(option)" class="details">{{ $t('edit.coverCurrent') }}</span>
            </button>
          </li>
        </ul>
        <p v-if="coversLoaded && coverOptions.length === 0" class="hint">{{ $t('edit.coversNone') }}</p>
      </div>

      <button v-if="hasCover" type="button" class="link" @click="removeCover">{{ $t('edit.removeCover') }}</button>

      <label v-if="!isBulk">{{ $t('edit.trackTitle') }}<input v-model="form.title" type="text" required maxlength="500" /></label>
      <label>{{ $t('edit.artist') }}<input v-model="form.artistName" type="text" :required="!isBulk" :placeholder="isBulk ? mixedHint : undefined" maxlength="500" /></label>
      <label>{{ $t('edit.album') }}<input v-model="form.album" type="text" :placeholder="isBulk ? mixedHint : undefined" maxlength="500" /></label>

      <label>{{ $t('edit.albumType') }}
        <select v-model="form.albumType">
          <option v-if="isBulk" value="__keep">{{ mixedHint }}</option>
          <option value="">{{ $t('edit.none') }}</option>
          <option value="album">{{ $t('edit.typeAlbum') }}</option>
          <option value="ep">{{ $t('edit.typeEp') }}</option>
        </select>
      </label>

      <label v-if="!isBulk">{{ $t('edit.trackNumber') }}<input v-model="form.trackNumber" type="number" min="1" step="1" /></label>
      <label>{{ $t('edit.releaseDate') }}<input v-model="form.releaseDate" type="date" /></label>
      <label>{{ $t('edit.label') }}<input v-model="form.label" type="text" :placeholder="isBulk ? mixedHint : undefined" maxlength="500" /></label>
      <label v-if="!isBulk">{{ $t('edit.duration') }}<input v-model="form.duration" type="text" placeholder="3:45" /></label>

      <template v-if="!isBulk">
        <label>{{ $t('edit.lyricsFormat') }}
          <select v-model="form.lyricsFormat">
            <option value="plain">{{ $t('edit.lyricsPlain') }}</option>
            <option value="lrc">{{ $t('edit.lyricsLrc') }}</option>
          </select>
        </label>
        <label class="lyrics">{{ $t('edit.lyrics') }}
          <textarea v-model="form.lyrics" rows="8" :placeholder="$t('edit.lyricsPlaceholder')" />
        </label>
      </template>

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
import { useAuthToken } from '~/composables/useAuthToken';

interface CoverOption {
  id: string,
  kind: "release-group" | "release",
  title: string,
  details: string | null,
  /** Cover Art Archive URL (or Nafyn's own form of it), stored as `coverArt` when picked */
  url: string
}

// one track (`media`), or several at once (`targets`, edited together: only what is shared can be changed)
const props = defineProps<{ modelValue: boolean, media?: MediaRow | null, targets?: MediaRow[] }>();
const emit = defineEmits<{
  (e: "update:modelValue", value: boolean): void,
  (e: "saved", media: MediaRow[]): void
}>();

const open = computed({
  get: () => props.modelValue,
  set: (value: boolean) => emit("update:modelValue", value)
});

const token = useAuthToken().token.value;
const { sendToast } = useToast();

const list = computed<MediaRow[]>(() => props.targets && props.targets.length > 0 ? props.targets : props.media ? [props.media] : []);
const isBulk = computed(() => list.value.length > 1);
const mixedHint = computed(() => $t('edit.mixed'));
// the sentinel a select shows while the tracks disagree on the album type; saving it leaves each one as it was
const KEEP = "__keep";

const form = reactive({
  title: "",
  artistName: "",
  album: "",
  albumType: "" as "" | "album" | "ep" | typeof KEEP,
  trackNumber: "" as number | string,
  releaseDate: "",
  label: "",
  duration: "",
  lyrics: "",
  lyricsFormat: "plain" as "plain" | "lrc"
});
// the shared fields as the form opened, so a bulk save only sends what the person actually changed
const initial = reactive({ artistName: "", album: "", albumType: "" as string, releaseDate: "", label: "" });

const saving = ref(false);
const coverFile = ref<File | null>(null);
const coverObjectUrl = ref<string | null>(null);
const fileInput = ref<HTMLInputElement | null>(null);
// bumped after every cover write so the <img> refetches instead of showing the browser-cached old one
const coverVersion = ref(0);
// lyrics as they were when the form opened, so an untouched field never rewrites (or deletes) what's stored
const originalLyrics = ref("");

const showCovers = ref(false);
const loadingCovers = ref(false);
const coversLoaded = ref(false);
const coverOptions = ref<CoverOption[]>([]);
const selectedCover = ref<CoverOption | null>(null);

const first = computed(() => list.value[0] ?? null);
const hasCover = computed(() => list.value.some((media) => !!media.hasCustomCover) || !!coverFile.value);
const coverPreview = computed(() => {
  if (coverObjectUrl.value) return coverObjectUrl.value;
  if (selectedCover.value) return coverArtUrl(selectedCover.value.url, 500);
  return coverSrcFresh(first.value, coverVersion.value);
});

function isCurrentCover(option: CoverOption): boolean {
  return !!first.value?.coverArt && first.value.coverArt.includes(option.id);
}

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

function isoDay(media: MediaRow): string {
  return media.releaseDate ? new Date(media.releaseDate * 1000).toISOString().slice(0, 10) : "";
}

// the value every track agrees on, or null when they differ
function common<T>(pick: (media: MediaRow) => T): T | null {
  const values = list.value.map(pick);
  return values.every((value) => value === values[0]) ? values[0]! : null;
}

async function loadForm() {
  const media = first.value;
  if (!media) return;

  form.title = media.title;
  form.artistName = common((m) => m.artistName) ?? "";
  form.album = common((m) => m.album ?? "") ?? "";
  const type = common((m) => m.albumType ?? "");
  form.albumType = type === null ? KEEP : type;
  form.trackNumber = media.trackNumber ?? "";
  form.releaseDate = common(isoDay) ?? "";
  form.label = common((m) => m.label ?? "") ?? "";
  form.duration = media.duration ? secondsToClock(media.duration) : "";
  Object.assign(initial, { artistName: form.artistName, album: form.album, albumType: form.albumType, releaseDate: form.releaseDate, label: form.label });

  coverFile.value = null;
  coverObjectUrl.value = null;
  selectedCover.value = null;
  showCovers.value = false;
  coverOptions.value = [];
  coversLoaded.value = false;

  if (isBulk.value) {
    form.lyrics = "";
    originalLyrics.value = "";
    return;
  }

  const stored = await $fetch<{ format: "plain" | "lrc", content: string } | null>(
    `/api/v1/library/${media.id}/lyrics`,
    { headers: { Authorization: token ?? "" }, query: { source: 1 } }
  ).catch(() => null);

  form.lyrics = stored?.content ?? "";
  form.lyricsFormat = stored?.format ?? "plain";
  originalLyrics.value = form.lyrics;
}

watch(() => [props.modelValue, list.value.map((m) => m.id).join(",")], () => {
  if (props.modelValue) loadForm();
});

const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// "Change cover art": the alternatives of the album (its MusicBrainz release-group), plus uploading one's own
async function toggleCovers() {
  showCovers.value = !showCovers.value;
  if (!showCovers.value || coversLoaded.value || loadingCovers.value) return;

  // the tracks have to share one album for its covers to make sense for all of them
  const albumId = common((m) => m.albumId);
  if (!albumId || !MBID.test(albumId) || !token) {
    coversLoaded.value = true;
    return;
  }

  loadingCovers.value = true;
  try {
    const result = await $fetch<{ options: CoverOption[] }>("/api/v1/library/cover-options", { headers: { Authorization: token }, query: { albumId } });
    coverOptions.value = result.options;
  } catch (e) {
    useToast().sendError(null, e, $t('edit.coverError'));
  } finally {
    loadingCovers.value = false;
    coversLoaded.value = true;
  }
}

function selectCover(option: CoverOption) {
  selectedCover.value = selectedCover.value?.id === option.id ? null : option;
  coverFile.value = null;
  coverObjectUrl.value = null;
}

function onCoverPick(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0] ?? null;
  coverFile.value = file;
  coverObjectUrl.value = file ? URL.createObjectURL(file) : null;
  if (file) selectedCover.value = null;
}

async function removeCover() {
  if (!token) return;

  coverFile.value = null;
  coverObjectUrl.value = null;
  selectedCover.value = null;

  for (const media of list.value.filter((m) => m.hasCustomCover)) {
    await $fetch(`/api/v1/library/${media.id}/cover`, { method: "DELETE", headers: { Authorization: token } })
      .catch((e) => useToast().sendError(media.title, e, $t('edit.coverError')));
  }
  coverVersion.value++;
}

// the fields of the form that differ from how it opened (bulk), or all of them (one track)
function bodyFor(): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  const changed = (field: keyof typeof initial) => !isBulk.value || form[field] !== initial[field];

  if (!isBulk.value) body.title = form.title;
  if (changed("artistName") && (form.artistName.trim() || !isBulk.value)) body.artistName = form.artistName;
  if (changed("album")) body.album = form.album.trim() || null;
  if (changed("albumType") && form.albumType !== KEEP) body.albumType = form.albumType || null;
  if (changed("releaseDate")) body.releaseDate = form.releaseDate ? Math.floor(new Date(`${form.releaseDate}T00:00:00Z`).getTime() / 1000) : null;
  if (changed("label")) body.label = form.label.trim() || null;

  if (!isBulk.value) {
    const duration = clockToSeconds(form.duration);
    const trackNumber = form.trackNumber === "" ? null : Number(form.trackNumber);
    body.trackNumber = trackNumber && trackNumber > 0 ? trackNumber : null;
    if (duration && duration > 0) body.duration = duration;
  }

  // a cover picked from the album's alternatives: stored like the one the download pipeline wrote
  if (selectedCover.value) body.coverArt = selectedCover.value.url;
  return body;
}

async function saveOne(media: MediaRow, body: Record<string, unknown>): Promise<MediaRow> {
  if (!token) return media;

  let updated = Object.keys(body).length > 0
    ? await $fetch<MediaRow>(`/api/v1/library/${media.id}`, { method: "PATCH", headers: { Authorization: token }, body })
    : media;

  if (coverFile.value) {
    const form = new FormData();
    form.append("cover", coverFile.value);
    await $fetch(`/api/v1/library/${media.id}/cover`, { method: "PUT", headers: { Authorization: token }, body: form });
    updated = { ...updated, hasCustomCover: 1 };
  } else if (selectedCover.value && updated.hasCustomCover) {
    // an uploaded cover outranks `coverArt`, so choosing an archive cover has to retire it
    await $fetch(`/api/v1/library/${media.id}/cover`, { method: "DELETE", headers: { Authorization: token } });
    updated = { ...updated, hasCustomCover: 0 };
  }

  return updated;
}

async function save() {
  if (list.value.length === 0 || !token) return;

  saving.value = true;
  const saved: MediaRow[] = [];
  try {
    const body = bodyFor();

    for (const media of list.value) {
      saved.push(await saveOne(media, body));
    }
    if (coverFile.value || selectedCover.value) coverVersion.value++;

    // only touch stored lyrics when the field actually changed, so opening the dialog to fix a typo in the
    // title never wipes lyrics that came from a provider or were entered earlier
    if (!isBulk.value && form.lyrics !== originalLyrics.value) {
      const media = list.value[0]!;
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

    sendToast({ title: isBulk.value ? null : saved[0]!.title, content: $t('edit.saved'), icon: null, tint: "green" });
    emit("saved", saved);
    open.value = false;
  } catch (e) {
    // tracks already written stay written; tell the page so its list shows them
    if (saved.length > 0) emit("saved", saved);
    const message = apiErrorMessage(e, $t('edit.error'));
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
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.media-edit .change-cover {
  background: none;
  border: 1px solid #ffffffae;
  border-radius: 250px;
  color: #ffffff;
  cursor: pointer;
  font-family: var(--font-discy);
  font-size: 0.85em;
  padding: 0.5em 1.2em;
}

.media-edit .change-cover:hover {
  background: #ffffff1a;
}

.media-edit .cover-gallery {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.media-edit .cover-gallery ul {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(104px, 1fr));
  gap: 10px;
  max-height: 260px;
  overflow-y: auto;
}

.media-edit .cover-gallery .tile {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  padding: 6px;
  border: 2px solid transparent;
  border-radius: 10px;
  background: #00000040;
  color: #ffffff;
  text-align: left;
  font-family: var(--font-discy);
  cursor: pointer;
}

.media-edit .cover-gallery .tile:hover {
  background: #ffffff1a;
}

/* the picked one is outlined, not just tinted: it must read without colour */
.media-edit .cover-gallery .tile.selected {
  border-color: #ffffff;
  background: #ffffff26;
}

.media-edit .cover-gallery .tile img {
  width: 100%;
  aspect-ratio: 1 / 1;
  border-radius: 6px;
  object-fit: cover;
  background: #00000040;
}

.media-edit .cover-gallery .tile .name {
  font-size: 0.75em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-edit .cover-gallery .tile .details {
  font-size: 0.65em;
  color: #ffffff;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.media-edit .cover-gallery .tile.upload {
  align-items: center;
  justify-content: center;
  aspect-ratio: 1 / 1;
  border: 2px dashed #ffffffae;
}

.media-edit .cover-gallery .tile.upload .plus {
  font-size: 2em;
  line-height: 1;
}

.media-edit .cover-gallery .hint {
  font-size: 0.8em;
  color: #ffffff;
}

.media-edit .cover-field img {
  width: 140px;
  height: 140px;
  border-radius: 10px;
  object-fit: cover;
  background: #00000040;
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

.media-edit .actions button {
  flex-shrink: 1;
  min-width: 0;
  padding: 0.6em 1.6em;
}
</style>
