<template>
  <div class="import-panel">
    <p class="subsonic-intro">{{ $t('transfer.intro') }}</p>

    <p v-if="!canImport" class="subsonic-note">{{ $t('transfer.noPermission') }}</p>

    <template v-else>
      <p v-if="activeJob" class="import-running">
        {{ $t('transfer.running') }}
        <NuxtLink :to="`/transfer/${activeJob.id}`">{{ $t('transfer.runningLink') }}</NuxtLink>
      </p>

      <div class="import-sources">
        <button
          v-for="p in providers"
          :key="p.id"
          type="button"
          class="import-source"
          :disabled="!p.configured || !!activeJob || connecting !== null"
          @click="connect(p)"
        >
          <img
            :src="TRANSFER_SOURCE_META[p.id].logo!"
            :class="{ wordmark: TRANSFER_SOURCE_META[p.id].wordmark }"
            :alt="TRANSFER_SOURCE_META[p.id].wordmark ? $t(`transfer.providers.${p.id}`) : ''"
            draggable="false"
          >
          <span class="col">
            <span v-if="!TRANSFER_SOURCE_META[p.id].wordmark" class="title">{{ $t(`transfer.providers.${p.id}`) }}</span>
            <span class="artist">{{ sourceNote(p) }}</span>
          </span>
        </button>

        <button type="button" class="import-source" :disabled="!!activeJob || connecting !== null" @click="fileOpen = true">
          <span class="file-glyph" aria-hidden="true">
            <svg viewBox="0 0 24 24"><path d="M6 2h8l6 6v14H6z M14 2v6h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>
          </span>
          <span class="col">
            <span class="title">{{ $t('transfer.providers.file') }}</span>
            <span class="artist">{{ $t('transfer.fileHint') }}</span>
          </span>
        </button>
      </div>

      <p class="subsonic-note">{{ $t('transfer.fileNote') }}</p>
    </template>

    <section class="subsection">
      <h2>{{ $t('transfer.history.title') }}</h2>
      <ul v-if="jobs.length > 0" class="api-token-list">
        <li v-for="job in jobs" :key="job.id">
          <img v-if="TRANSFER_SOURCE_META[job.provider].logo" class="history-logo" :src="TRANSFER_SOURCE_META[job.provider].logo!" alt="" draggable="false">
          <NuxtLink :to="`/transfer/${job.id}`" class="col history-link">
            <span class="title">{{ $t(`transfer.providers.${job.provider}`) }} &middot; {{ $t(`transfer.job.status.${job.status}`) }}</span>
            <span class="artist">{{ formatDate(job.createdAt) }} &middot; {{ $t('transfer.history.summary', { done: job.counts.completed, failed: job.counts.failed }) }}</span>
          </NuxtLink>
          <button
            v-if="!isActive(job)"
            class="danger"
            type="button"
            filled="hollow"
            :disabled="removingId === job.id"
            @click="removeJob(job.id)"
          >
            {{ $t('transfer.history.remove') }}
          </button>
        </li>
      </ul>
      <p v-else-if="!jobsLoading" class="subsonic-note">{{ $t('transfer.history.empty') }}</p>
      <div ref="jobsSentinel" class="scroll-sentinel" />
    </section>

    <Modal v-model="deezerOpen" :title="$t('transfer.deezer.title')">
      <p class="subsonic-note">{{ $t('transfer.deezer.hint') }}</p>
      <input v-model="deezerProfile" type="text" :placeholder="$t('transfer.deezer.placeholder')" @keydown.enter="connectDeezerProfile">
      <button type="button" filled :disabled="!deezerProfile.trim() || connecting !== null" @click="connectDeezerProfile">{{ $t('transfer.deezer.continue') }}</button>
      <button v-if="deezerOAuth" type="button" filled="hollow" :disabled="connecting !== null" @click="startOAuth('deezer')">{{ $t('transfer.deezer.signIn') }}</button>
    </Modal>

    <Modal v-model="fileOpen" :title="$t('transfer.file.title')">
      <p class="subsonic-note">{{ $t('transfer.file.hint') }}</p>
      <input ref="fileInput" type="file" accept=".csv,.json,.txt,.tsv,text/csv,application/json,text/plain" class="hidden-input" @change="onFilePicked">
      <button type="button" filled="hollow" @click="fileInput?.click()">{{ file ? $t('transfer.file.change') : $t('transfer.file.pick') }}</button>
      <p v-if="file" class="picked-file">{{ file.name }}</p>
      <label class="switch-row">
        <input v-model="filePlaylistEnabled" type="checkbox">
        {{ $t('transfer.file.playlist') }}
      </label>
      <input v-if="filePlaylistEnabled" v-model="filePlaylistName" type="text" maxlength="200" :placeholder="$t('transfer.file.playlistPlaceholder')">
      <button type="button" filled :disabled="!file || uploading || (filePlaylistEnabled && !filePlaylistName.trim())" @click="uploadFile">{{ $t('transfer.file.submit') }}</button>
    </Modal>
  </div>
</template>

<script lang="ts" setup>
import Modal from '~/components/Modal.vue';
import type { TransferJob, TransferProviderStatus } from '~~/server/entity/Transfer';
import { hasPermission, Permission } from '~~/server/entity/Permission';

const props = defineProps<{ permissions: number }>();

const token = useCookie("nafynToken").value ?? "";
const headers = { Authorization: token };

const canImport = computed(() => hasPermission(props.permissions, Permission.REQUEST_TRACKS) || hasPermission(props.permissions, Permission.REQUEST_ALBUMS));

const providers = ref<TransferProviderStatus[]>([]);
const connecting = ref<string | null>(null);

const { items: jobs, initialLoading: jobsLoading, sentinel: jobsSentinel, loadMore: loadMoreJobs, reset: resetJobs } = useInfiniteList<TransferJob>((page, limit) => {
  return $fetch("/api/v1/transfer/jobs", { headers, query: { page, limit } });
}, 20);

const activeJob = computed(() => jobs.value.find(isActive) ?? null);

function isActive(job: TransferJob): boolean {
  return job.status === "fetching" || job.status === "matching" || job.status === "downloading";
}

function sourceNote(p: TransferProviderStatus): string {
  if (!p.configured) return $t('transfer.unavailable');
  if (p.id === "amazon") return $t('transfer.beta');
  return connecting.value === p.id ? $t('transfer.connecting') : $t('transfer.import');
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString();
}

function toastError(e: unknown, fallback = $t('settings.profile.error')) {
  useToast().sendToast({ title: $t('transfer.title'), content: transferErrorMessage(e, fallback), tint: "red", icon: null });
}

onMounted(async () => {
  await Promise.all([
    $fetch<TransferProviderStatus[]>("/api/v1/transfer/providers", { headers }).then((list) => { providers.value = list; }).catch(() => {}),
    loadMoreJobs()
  ]);
});

// -- connecting --

const deezerOpen = ref(false);
const deezerProfile = ref("");
const deezerOAuth = computed(() => providers.value.find((p) => p.id === "deezer")?.authModes.includes("oauth") ?? false);

function goToSelection(sessionId: string) {
  navigateTo({ path: "/transfer/select", query: { session: sessionId } });
}

async function connect(p: TransferProviderStatus) {
  if (p.id === "apple") return connectApple();
  if (p.id === "deezer") {
    deezerOpen.value = true;
    return;
  }
  return startOAuth(p.id);
}

// full-page redirect to the service's own sign-in; it comes back to /transfer/callback
async function startOAuth(provider: string) {
  connecting.value = provider;
  try {
    const { url } = await $fetch<{ url: string }>("/api/v1/transfer/connect", { method: "POST", headers, body: { provider } });
    window.location.assign(url);
  } catch (e) {
    toastError(e);
    connecting.value = null;
  }
}

async function connectApple() {
  connecting.value = "apple";
  try {
    const { developerToken } = await $fetch<{ developerToken: string }>("/api/v1/transfer/apple-token", { headers });
    const MusicKit = await loadMusicKit();
    await MusicKit.configure({ developerToken, app: { name: "Nafyn", build: "1.0.0" } });
    const musicUserToken: string = await MusicKit.getInstance().authorize();
    if (!musicUserToken) throw new Error("no token");

    const { sessionId } = await $fetch<{ sessionId: string }>("/api/v1/transfer/session", { method: "POST", headers, body: { provider: "apple", musicUserToken } });
    goToSelection(sessionId);
  } catch (e) {
    toastError(e, $t('transfer.apple.error'));
  } finally {
    connecting.value = null;
  }
}

async function connectDeezerProfile() {
  if (!deezerProfile.value.trim()) return;
  connecting.value = "deezer";
  try {
    const { sessionId } = await $fetch<{ sessionId: string }>("/api/v1/transfer/session", { method: "POST", headers, body: { provider: "deezer", profile: deezerProfile.value.trim() } });
    deezerOpen.value = false;
    goToSelection(sessionId);
  } catch (e) {
    toastError(e);
  } finally {
    connecting.value = null;
  }
}

// -- file import --

const fileOpen = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const file = ref<File | null>(null);
const filePlaylistEnabled = ref(false);
const filePlaylistName = ref("");
const uploading = ref(false);

function onFilePicked(e: Event) {
  const picked = (e.target as HTMLInputElement).files?.[0] ?? null;
  file.value = picked;
  // the file's own name is the obvious default for "put these in a playlist"
  if (picked && !filePlaylistName.value) filePlaylistName.value = picked.name.replace(/\.[^.]+$/, "");
}

async function uploadFile() {
  if (!file.value) return;
  uploading.value = true;
  try {
    const body = new FormData();
    body.append("file", file.value);
    if (filePlaylistEnabled.value && filePlaylistName.value.trim()) body.append("playlist", filePlaylistName.value.trim());

    const job = await $fetch<TransferJob>("/api/v1/transfer/file", { method: "POST", headers, body });
    fileOpen.value = false;
    navigateTo(`/transfer/${job.id}`);
  } catch (e) {
    toastError(e);
  } finally {
    uploading.value = false;
  }
}

// -- history --

const removingId = ref<string | null>(null);

async function removeJob(id: string) {
  removingId.value = id;
  try {
    await $fetch(`/api/v1/transfer/jobs/${id}`, { method: "DELETE", headers });
    await resetJobs();
  } catch (e) {
    toastError(e);
  } finally {
    removingId.value = null;
  }
}
</script>

<style>
.import-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.import-running {
  font-size: 0.75em;
  padding: 10px 14px;
  border-radius: 12px;
  background: #e18c461a;
  border: 1px solid #e18c4655;
  color: #e18c46;
}

.import-sources {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.import-source {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  border-radius: 12px;
  background: #00000030;
  color: inherit;
  text-align: left;
  min-width: 0;
  transition: background 0.15s ease;
}

.import-source:hover:not(:disabled) {
  background: #ffffff14;
}

.import-source:disabled {
  opacity: 0.45;
}

/* brand marks keep their own proportions and clear space - never stretched or recoloured */
.import-source img {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  object-fit: contain;
}

.import-source img.wordmark {
  width: auto;
  max-width: 120px;
  height: 22px;
  margin: 3px 0;
}

.import-source .col {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.import-source .title {
  font-size: 0.8em;
  color: #ffffffd0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-source .artist {
  font-family: "Discy";
  font-size: 0.55em;
  color: #999999;
}

.file-glyph {
  width: 28px;
  height: 28px;
  flex-shrink: 0;
  color: #ffffffae;
}

.file-glyph svg {
  width: 100%;
  height: 100%;
}

.picked-file {
  font-family: "Discy";
  font-size: 0.7em;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.history-logo {
  width: 22px;
  height: 22px;
  object-fit: contain;
  flex-shrink: 0;
}

.history-link {
  text-decoration: none;
}

@media screen and (max-width: 800px) {
  .import-sources {
    grid-template-columns: 1fr;
  }
}
</style>
