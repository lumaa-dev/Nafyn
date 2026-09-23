<template>
  <div class="transfer-page">
    <template v-if="job">
      <div class="transfer-heading">
        <img v-if="meta?.logo" :src="meta.logo" :class="{ wordmark: meta.wordmark }" :alt="meta.wordmark ? providerName : ''" draggable="false">
        <h1>{{ $t('transfer.job.title', { service: providerName }) }}</h1>
      </div>
      <p class="transfer-note">{{ $t('transfer.job.started', { date: new Date(job.createdAt).toLocaleString() }) }}</p>

      <section class="transfer-section">
        <div class="transfer-row">
          <h2 :class="['job-status', job.status]">{{ $t(`transfer.job.status.${job.status}`) }}</h2>
          <span class="job-progress-label">{{ $t('transfer.job.progress', { done: processed, total: job.totalItems }) }}</span>
        </div>
        <div class="transfer-bar">
          <div class="transfer-fill" :class="{ indeterminate: job.status === 'fetching' }" :style="{ width: job.status === 'fetching' ? '100%' : `${percent}%` }" />
        </div>
        <p v-if="job.error" class="transfer-error">{{ job.error }}</p>
        <p v-if="job.truncated" class="transfer-note">{{ $t('transfer.job.truncated') }}</p>
        <p v-if="isActive" class="transfer-note">{{ $t('transfer.job.slow') }}</p>

        <div class="job-stats">
          <div class="job-stat">
            <span class="value">{{ imported }}</span>
            <span class="label">{{ $t('transfer.job.stats.imported') }}</span>
          </div>
          <div class="job-stat">
            <span class="value">{{ job.alreadyOwned }}</span>
            <span class="label">{{ $t('transfer.job.stats.owned') }}</span>
          </div>
          <div class="job-stat" :class="{ bad: job.counts.failed > 0 }">
            <span class="value">{{ job.counts.failed }}</span>
            <span class="label">{{ $t('transfer.job.stats.failed') }}</span>
          </div>
          <div class="job-stat">
            <span class="value">{{ remaining }}</span>
            <span class="label">{{ $t('transfer.job.stats.remaining') }}</span>
          </div>
        </div>

        <div class="transfer-actions">
          <button v-if="isActive" type="button" filled="hollow" class="danger" :disabled="acting" @click="cancel">{{ $t('transfer.job.cancel') }}</button>
          <button v-if="canRetry" type="button" filled="hollow" :disabled="acting" @click="retry">{{ $t('transfer.job.retry') }}</button>
        </div>
      </section>

      <!-- the failure report: how many couldn't be imported, and why -->
      <section v-if="job.counts.failed > 0" class="transfer-section">
        <h2>{{ $t('transfer.job.failuresTitle') }}</h2>
        <p class="failure-summary">{{ $t('transfer.job.failuresSummary', job.counts.failed) }}</p>
        <ul class="failure-reasons">
          <li v-for="[reason, count] in failureReasons" :key="reason">
            <span class="count">{{ count }}</span>
            <span>{{ $t(`transfer.job.reasons.${reason}`) }}</span>
          </li>
        </ul>
      </section>

      <section class="transfer-section">
        <div class="job-filters">
          <button
            v-for="f in filters"
            :key="f"
            type="button"
            :class="{ active: filter === f }"
            @click="filter = f"
          >
            {{ $t(`transfer.job.filter.${f}`) }}
          </button>
        </div>

        <ul v-if="items.length > 0" class="job-items">
          <li v-for="item in items" :key="item.id" :class="item.status">
            <span class="kind">{{ $t(`transfer.job.kind.${item.kind}`) }}</span>
            <span class="col">
              <NuxtLink v-if="linkFor(item)" :to="linkFor(item)!" class="title">{{ item.title ?? '—' }}</NuxtLink>
              <span v-else class="title">{{ item.title ?? '—' }}</span>
              <span class="artist">
                {{ [item.kind !== 'artist' ? item.artistName : null, item.playlistTitle].filter(Boolean).join(' · ') }}
              </span>
              <span class="state">{{ itemState(item) }}</span>
            </span>
          </li>
        </ul>
        <p v-else-if="!itemsLoading" class="transfer-note">{{ $t('transfer.job.empty') }}</p>
        <div ref="itemsSentinel" class="transfer-sentinel" />
        <p v-if="itemsLoadingMore" class="transfer-loading">{{ $t('common.loadingMore') }}</p>
      </section>

      <NuxtLink to="/settings?tab=import" class="transfer-link">{{ $t('transfer.callback.back') }}</NuxtLink>
    </template>

    <template v-else-if="notFound">
      <p class="transfer-error">{{ $t('transfer.job.notFound') }}</p>
      <NuxtLink to="/settings?tab=import" class="transfer-link">{{ $t('transfer.callback.back') }}</NuxtLink>
    </template>
  </div>
</template>

<script lang="ts" setup>
import '~/assets/css/transfer.css';
import type { TransferFailReason, TransferItem, TransferJob } from '~~/server/entity/Transfer';

type Filter = "failed" | "all" | "completed" | "remaining";

const route = useRoute();
const token = useCookie("nafynToken").value ?? "";
const headers = { Authorization: token };
const jobId = String(route.params.id);

const job = ref<TransferJob | null>(null);
const notFound = ref(false);
const acting = ref(false);

const meta = computed(() => job.value ? TRANSFER_SOURCE_META[job.value.provider] : null);
const providerName = computed(() => job.value ? $t(`transfer.providers.${job.value.provider}`) : "");

const isActive = computed(() => !!job.value && ["fetching", "matching", "downloading"].includes(job.value.status));
const processed = computed(() => job.value ? job.value.counts.completed + job.value.counts.failed + job.value.counts.skipped : 0);
const remaining = computed(() => job.value ? job.value.counts.pending + job.value.counts.matched + job.value.counts.requested : 0);
const imported = computed(() => job.value ? job.value.counts.completed - job.value.alreadyOwned : 0);
const percent = computed(() => job.value && job.value.totalItems > 0 ? Math.min(100, processed.value / job.value.totalItems * 100) : 0);
const canRetry = computed(() => !!job.value && !isActive.value && (job.value.failures.download_failed ?? 0) > 0);

const failureReasons = computed(() => {
  const entries = Object.entries(job.value?.failures ?? {}) as [TransferFailReason, number][];
  return entries.filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
});

const { data } = await useFetch<TransferJob>(`/api/v1/transfer/jobs/${encodeURIComponent(jobId)}`, { headers });
if (data.value) job.value = data.value;
else notFound.value = true;

// failed first when there's anything to report - that's what the user needs to see
const filters: Filter[] = ["failed", "all", "completed", "remaining"];
const filter = ref<Filter>(job.value && job.value.counts.failed > 0 ? "failed" : "all");

const { items, initialLoading: itemsLoading, loadingMore: itemsLoadingMore, sentinel: itemsSentinel, loadMore, reset } = useInfiniteList<TransferItem>((page, limit) => {
  return $fetch(`/api/v1/transfer/jobs/${encodeURIComponent(jobId)}/items`, { headers, query: { page, limit, filter: filter.value } });
});

watch(filter, () => reset());

function linkFor(item: TransferItem): string | null {
  if (!item.musicbrainzId) return null;
  if (item.kind === "artist") return `/ar/${item.musicbrainzId}`;
  if (item.kind === "album") return `/a/${item.musicbrainzId}`;
  return `/t/${item.musicbrainzId}`;
}

function itemState(item: TransferItem): string {
  if (item.status === "failed") return $t(`transfer.job.reasons.${item.failReason ?? 'not_found'}`);
  if (item.status === "completed") return item.alreadyOwned ? $t('transfer.job.owned') : $t('transfer.job.filter.completed');
  return $t(`transfer.job.${item.status}`);
}

// -- live progress --

let timer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  const wasActive = isActive.value;
  const next = await $fetch<TransferJob>(`/api/v1/transfer/jobs/${encodeURIComponent(jobId)}`, { headers }).catch(() => null);
  if (!next) return;
  job.value = next;

  if (wasActive && !isActive.value) {
    stopPolling();
    if (next.status === "completed") {
      useToast().sendToast({
        title: $t('transfer.title'),
        content: $t('transfer.job.done', { ok: next.counts.completed, failed: next.counts.failed }),
        tint: next.counts.failed > 0 ? null : "green",
        icon: null
      });
    }
    // land on the failure report once there is one
    if (next.counts.failed > 0 && filter.value !== "failed") filter.value = "failed";
    else await reset();
  }
}

function startPolling() {
  if (timer || !isActive.value) return;
  timer = setInterval(refresh, 4000);
}

function stopPolling() {
  if (timer) clearInterval(timer);
  timer = null;
}

onMounted(async () => {
  if (job.value) await loadMore();
  startPolling();
});
onUnmounted(stopPolling);

async function cancel() {
  if (!confirm($t('transfer.job.cancelConfirm'))) return;
  acting.value = true;
  try {
    job.value = await $fetch<TransferJob>(`/api/v1/transfer/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST", headers });
    stopPolling();
    await reset();
  } catch (e) {
    useToast().sendToast({ title: $t('transfer.title'), content: transferErrorMessage(e, $t('settings.profile.error')), tint: "red", icon: null });
  } finally {
    acting.value = false;
  }
}

async function retry() {
  acting.value = true;
  try {
    job.value = await $fetch<TransferJob>(`/api/v1/transfer/jobs/${encodeURIComponent(jobId)}/retry`, { method: "POST", headers });
    filter.value = "remaining";
    startPolling();
  } catch (e) {
    useToast().sendToast({ title: $t('transfer.title'), content: transferErrorMessage(e, $t('settings.profile.error')), tint: "red", icon: null });
  } finally {
    acting.value = false;
  }
}
</script>

<style>
.job-status {
  font-size: 0.9em;
}

.job-status.failed,
.job-status.cancelled {
  color: #e06666;
}

.job-status.completed {
  color: #93c47d;
}

.job-progress-label {
  font-family: "Discy";
  font-variant-numeric: tabular-nums;
  font-size: 0.6em;
  color: #999999;
}

.transfer-fill.indeterminate {
  opacity: 0.5;
  animation: transfer-pulse 1.4s ease-in-out infinite;
}

@keyframes transfer-pulse {
  50% { opacity: 0.15; }
}

.job-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.job-stat {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #00000030;
  min-width: 0;
}

.job-stat .value {
  font-family: "Discy";
  font-variant-numeric: tabular-nums;
  font-size: 1em;
  color: #ffffffd0;
}

.job-stat .label {
  font-family: "Discy";
  font-size: 0.5em;
  color: #999999;
}

.job-stat.bad {
  background: #e066661a;
  border: 1px solid #e0666655;
}

.job-stat.bad .value {
  color: #e06666;
}

.failure-summary {
  font-size: 0.8em;
  color: #e06666;
}

.failure-reasons {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  padding: 0;
  font-size: 0.7em;
}

.failure-reasons li {
  display: flex;
  align-items: baseline;
  gap: 10px;
}

.failure-reasons .count {
  font-family: "Discy";
  font-variant-numeric: tabular-nums;
  min-width: 2.5em;
  text-align: right;
  color: #ffffffd0;
}

.job-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.job-filters button {
  color: #ffffffae;
  font-family: "Instrument-Serif";
  font-size: 0.7em;
  padding: 6px 14px;
  border-radius: 250px;
}

.job-filters button.active {
  background: #ffffffae;
  color: #000;
}

.job-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
  list-style: none;
  padding: 0;
}

.job-items li {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 10px;
  background: #00000030;
  min-width: 0;
}

.job-items .kind {
  font-family: "Discy";
  font-size: 0.5em;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #999999;
  width: 4.5em;
  flex-shrink: 0;
}

.job-items .col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.job-items .title,
.job-items .artist {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.job-items .title {
  font-size: 0.8em;
}

.job-items .artist,
.job-items .state {
  font-family: "Discy";
  font-size: 0.55em;
  color: #999999;
}

.job-items li.failed .state {
  color: #e06666;
}

.job-items li.completed .state {
  color: #93c47d;
}

@media screen and (max-width: 800px) {
  .job-stats {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
