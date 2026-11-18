<template>
  <div class="connections">
    <!-- ListenBrainz scrobbling (server side, every client): connect once with the user token, then pause / resume or disconnect -->
    <section class="subsection">
      <h2>{{ $t('settings.connections.listenbrainz.title') }}</h2>
      <LoadError :error="listenBrainzError" />
      <template v-if="listenBrainz">
        <template v-if="listenBrainz.username">
          <p class="subsonic-note">{{ $t('settings.connections.listenbrainz.connectedAs', { username: listenBrainz.username }) }}</p>
          <label class="switch-row">
            <input type="checkbox" :checked="listenBrainz.scrobbling" :disabled="listenBrainzBusy" @change="toggleScrobbling">
            {{ $t('settings.connections.listenbrainz.scrobbling') }}
          </label>
          <span class="row">
            <button type="button" filled="hollow" class="danger" :disabled="listenBrainzBusy" @click="disconnectListenBrainz">{{ $t('settings.connections.listenbrainz.disconnect') }}</button>
          </span>
        </template>
        <form v-else @submit.prevent="connectListenBrainz">
          <p class="subsonic-note">
            {{ $t('settings.connections.listenbrainz.intro') }}
            <a href="https://listenbrainz.org/settings/" target="_blank" rel="noopener noreferrer">{{ $t('settings.connections.listenbrainz.tokenLink') }}</a>
          </p>
          <input v-model="listenBrainzToken" type="password" autocomplete="off" maxlength="128" :placeholder="$t('settings.connections.listenbrainz.tokenPlaceholder')" :disabled="listenBrainzBusy">
          <span class="row">
            <button type="submit" filled="hollow" :disabled="listenBrainzBusy || !listenBrainzToken.trim()">{{ $t('settings.connections.listenbrainz.connect') }}</button>
          </span>
        </form>
      </template>
    </section>

    <!-- Discogs: the albums of the (public) collection, requested like the iOS app's Apple Music import -->
    <section class="subsection">
      <h2>{{ $t('settings.connections.discogs.title') }}</h2>
      <p class="subsonic-note">{{ $t('settings.connections.discogs.intro') }}</p>
      <span class="row">
        <button type="button" filled="hollow" :disabled="discogsBusy || !savedDiscogs || running !== null" @click="importDiscogs">
          {{ discogsBusy ? $t('settings.connections.discogs.reading') : $t('settings.connections.discogs.import') }}
        </button>
      </span>
      <p v-if="!savedDiscogs" class="subsonic-note">{{ $t('settings.connections.discogs.noUsername') }}</p>
      <div v-if="job" class="import-progress" role="status">
        <p>{{ job.status === 'running' ? $t('settings.connections.discogs.progress', { processed: job.processed, total: job.total }) : $t('settings.connections.discogs.done', { total: job.total }) }}</p>
        <div class="bar"><div class="fill" :style="{ width: `${job.total ? job.processed / job.total * 100 : 0}%` }" /></div>
        <p class="subsonic-note">{{ countsText }}</p>
      </div>
    </section>
  </div>
</template>

<script lang="ts" setup>
import { useAuthToken } from '~/composables/useAuthToken';
import { setScrobblingState } from '~/composables/usePlayTracking';
import LoadError from '~/components/LoadError.vue';

const props = defineProps<{ discogsUsername: string | null }>();

interface ListenBrainzConnection { username: string | null, scrobbling: boolean }
interface ImportJob {
  id: string,
  status: "running" | "completed",
  total: number,
  processed: number,
  counts: Record<string, number>
}

const { t } = useI18n();
const { token } = useAuthToken();
const headers = () => ({ Authorization: token.value ?? "" });

const listenBrainz = ref<ListenBrainzConnection | null>(null);
const listenBrainzError = ref<unknown>(null);
const listenBrainzBusy = ref(false);
const listenBrainzToken = ref("");

async function loadListenBrainz() {
  try {
    listenBrainz.value = await $fetch<ListenBrainzConnection>("/api/v1/user/listenbrainz", { headers: headers() });
    listenBrainzError.value = null;
  } catch (e) {
    listenBrainzError.value = e;
  }
}

async function connectListenBrainz() {
  const value = listenBrainzToken.value.trim();
  if (!value) return;
  listenBrainzBusy.value = true;
  try {
    // the server checks the token with ListenBrainz before keeping it
    listenBrainz.value = await $fetch<ListenBrainzConnection>("/api/v1/user/listenbrainz", { method: "POST", headers: headers(), body: { token: value } });
    listenBrainzToken.value = "";
    setScrobblingState(listenBrainz.value.scrobbling);
    useToast().sendToast({ title: t('settings.connections.listenbrainz.title'), content: t('settings.connections.listenbrainz.connected'), tint: "green", icon: null });
  } catch (e) {
    useToast().sendError(t('settings.connections.listenbrainz.failed'), e);
  } finally {
    listenBrainzBusy.value = false;
  }
}

async function toggleScrobbling(e: Event) {
  const wanted = (e.target as HTMLInputElement).checked;
  listenBrainzBusy.value = true;
  try {
    listenBrainz.value = await $fetch<ListenBrainzConnection>("/api/v1/user/listenbrainz", { method: "PATCH", headers: headers(), body: { scrobbling: wanted } });
    setScrobblingState(listenBrainz.value.scrobbling);
  } catch (err) {
    (e.target as HTMLInputElement).checked = !wanted;
    useToast().sendError(t('settings.connections.listenbrainz.title'), err);
  } finally {
    listenBrainzBusy.value = false;
  }
}

async function disconnectListenBrainz() {
  listenBrainzBusy.value = true;
  try {
    await $fetch("/api/v1/user/listenbrainz", { method: "DELETE", headers: headers() });
    setScrobblingState(false);
    await loadListenBrainz();
  } catch (e) {
    useToast().sendError(t('settings.connections.listenbrainz.title'), e);
  } finally {
    listenBrainzBusy.value = false;
  }
}

// -- Discogs --

const discogsBusy = ref(false);
const job = ref<ImportJob | null>(null);
const running = computed(() => job.value?.status === "running" ? job.value : null);
let pollTimer: ReturnType<typeof setTimeout> | null = null;

const countsText = computed(() => {
  const counts = job.value?.counts ?? {};
  return (["requested", "owned", "already-requested", "not-found", "unreleased", "error"] as const)
    .filter((status) => (counts[status] ?? 0) > 0)
    .map((status) => t(`settings.connections.discogs.status.${status}`, { count: counts[status] }))
    .join(" · ");
});

async function poll() {
  if (!job.value) return;
  try {
    job.value = await $fetch<ImportJob>(`/api/v1/import/${job.value.id}`, { headers: headers() });
  } catch {
    // the next tick tries again; the progress shown is just a little older
  }
  if (job.value?.status === "running") pollTimer = setTimeout(poll, 5000);
}

async function importDiscogs() {
  discogsBusy.value = true;
  try {
    job.value = await $fetch<ImportJob>("/api/v1/import/discogs", { method: "POST", headers: headers(), body: {} });
    useToast().sendToast({ title: t('settings.connections.discogs.title'), content: t('settings.connections.discogs.started', { total: job.value.total }), tint: "green", icon: null });
    pollTimer = setTimeout(poll, 5000);
  } catch (e) {
    useToast().sendError(t('settings.connections.discogs.title'), e);
  } finally {
    discogsBusy.value = false;
  }
}

onMounted(async () => {
  await loadListenBrainz();
});

onBeforeUnmount(() => { if (pollTimer) clearTimeout(pollTimer); });

// the saved profile's (the field above may hold an unsaved edit)
const savedDiscogs = computed(() => props.discogsUsername?.trim() || null);
</script>

<style scoped>
.connections .row {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.connections form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.import-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.import-progress p {
  margin: 0;
}

.import-progress .bar {
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: #ffffff26;
  overflow: hidden;
}

.import-progress .fill {
  height: 100%;
  background: #ffffff;
  transition: width 0.3s ease-out;
}

@media (prefers-reduced-motion: reduce) {
  .import-progress .fill { transition: none; }
}
</style>
