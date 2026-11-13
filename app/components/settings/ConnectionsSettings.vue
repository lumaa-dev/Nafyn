<template>
  <div class="connections">
    <!-- Last.fm scrobbling (server side, every client): connect once on last.fm, then pause / resume or disconnect -->
    <section class="subsection">
      <h2>{{ $t('settings.connections.lastfm.title') }}</h2>
      <LoadError :error="lastfmError" />
      <template v-if="lastfm">
        <p v-if="!lastfm.available" class="subsonic-note">{{ $t('settings.connections.lastfm.unavailable') }}</p>
        <template v-else-if="lastfm.username">
          <p class="subsonic-note">{{ $t('settings.connections.lastfm.connectedAs', { username: lastfm.username }) }}</p>
          <label class="switch-row">
            <input type="checkbox" :checked="lastfm.scrobbling" :disabled="lastfmBusy" @change="toggleScrobbling">
            {{ $t('settings.connections.lastfm.scrobbling') }}
          </label>
          <span class="row">
            <button type="button" filled="hollow" class="danger" :disabled="lastfmBusy" @click="disconnectLastfm">{{ $t('settings.connections.lastfm.disconnect') }}</button>
          </span>
        </template>
        <template v-else>
          <p class="subsonic-note">{{ $t('settings.connections.lastfm.intro') }}</p>
          <span class="row">
            <button type="button" filled="hollow" :disabled="lastfmBusy" @click="connectLastfm">{{ $t('settings.connections.lastfm.connect') }}</button>
          </span>
        </template>
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

interface LastfmConnection { available: boolean, username: string | null, scrobbling: boolean }
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
const route = useRoute();

const lastfm = ref<LastfmConnection | null>(null);
const lastfmError = ref<unknown>(null);
const lastfmBusy = ref(false);

async function loadLastfm() {
  try {
    lastfm.value = await $fetch<LastfmConnection>("/api/v1/user/lastfm", { headers: headers() });
    lastfmError.value = null;
  } catch (e) {
    lastfmError.value = e;
  }
}

async function connectLastfm() {
  lastfmBusy.value = true;
  try {
    const { url } = await $fetch<{ url: string }>("/api/v1/user/lastfm/connect", { method: "POST", headers: headers(), body: { client: "web" } });
    // last.fm sends the browser back to /settings?lastfm=connected|error
    window.location.href = url;
  } catch (e) {
    useToast().sendError(t('settings.connections.lastfm.title'), e);
    lastfmBusy.value = false;
  }
}

async function toggleScrobbling(e: Event) {
  const wanted = (e.target as HTMLInputElement).checked;
  lastfmBusy.value = true;
  try {
    lastfm.value = await $fetch<LastfmConnection>("/api/v1/user/lastfm", { method: "PATCH", headers: headers(), body: { scrobbling: wanted } });
    setScrobblingState(lastfm.value.scrobbling);
  } catch (err) {
    (e.target as HTMLInputElement).checked = !wanted;
    useToast().sendError(t('settings.connections.lastfm.title'), err);
  } finally {
    lastfmBusy.value = false;
  }
}

async function disconnectLastfm() {
  lastfmBusy.value = true;
  try {
    await $fetch("/api/v1/user/lastfm", { method: "DELETE", headers: headers() });
    setScrobblingState(false);
    await loadLastfm();
  } catch (e) {
    useToast().sendError(t('settings.connections.lastfm.title'), e);
  } finally {
    lastfmBusy.value = false;
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
  await loadLastfm();
  const outcome = route.query.lastfm;
  if (outcome === "connected" || outcome === "error") {
    if (outcome === "connected") {
      setScrobblingState(true);
      useToast().sendToast({ title: t('settings.connections.lastfm.title'), content: t('settings.connections.lastfm.connected'), tint: "green", icon: null });
    } else {
      useToast().sendToast({ title: t('settings.connections.lastfm.title'), content: t('settings.connections.lastfm.failed'), tint: "red", icon: null });
    }
    await navigateTo({ path: route.path, query: { ...route.query, lastfm: undefined } }, { replace: true });
  }
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
