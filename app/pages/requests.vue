<template>
  <div class="requests">
    <div class="req-head">
      <h1>{{ $t('requests.title') }}</h1>
      <button type="button" class="filter-btn" :class="{ active: filters.length > 0 }" aria-haspopup="menu" :title="$t('requests.filter.title')" :aria-label="filterLabel" @click="openFilter">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4-2v-4z" /></svg>
        <span v-if="filters.length > 0" class="count">{{ filters.length }}</span>
      </button>
    </div>
    <ContextMenu ref="filterMenu" :items="filterItems" />
    <div class="reqs" v-if="requests.length > 0">
      <RequestRow v-for="req in requests" :key="req.id" :request="req" :is-compact="false" @deleted="onDeleted" />
    </div>
    <div class="err" v-else-if="!initialLoading">
      <p>{{ $t('requests.empty') }}</p>
    </div>
    <div ref="sentinel" class="scroll-sentinel" />
    <p class="loading-more" v-if="loadingMore">{{ $t('common.loadingMore') }}</p>
  </div>
</template>

<script lang="ts" setup>
import ContextMenu, { type ContextMenuItem } from '~/components/ContextMenu.vue';
import RequestRow from '~/components/RequestRow.vue';
import type { NafynRequest } from '~~/server/entity/NafynRequest';
import { useAuthToken } from '~/composables/useAuthToken';

const { token } = useAuthToken();

// The groups the list is narrowed to (GET /api/v1/requests takes `<group>=false` for each one left out). Nothing
// selected is the "All" filter; "All" excludes the others, and picking every group is the same as All.
const GROUPS = ["succeeded", "failed", "waiting", "processing"] as const;
type Group = typeof GROUPS[number];
const filters = ref<Group[]>([]);

function filterQuery(): Record<string, string> {
  if (filters.value.length === 0) return {};
  return Object.fromEntries(GROUPS.filter((group) => !filters.value.includes(group)).map((group) => [group, "false"]));
}

const { items: requests, initialLoading, loadingMore, sentinel, loadMore, reset } = useInfiniteList<NafynRequest>((page, limit) => {
  return token.value
    ? $fetch("/api/v1/requests", { headers: { Authorization: token.value }, query: { page, limit, ...filterQuery() } })
    : Promise.resolve({ items: [], page, limit, total: 0, hasMore: false });
});
await loadMore();

const filterMenu = ref<InstanceType<typeof ContextMenu> | null>(null);

const filterItems = computed<ContextMenuItem[]>(() => [
  { label: $t('requests.filter.all'), checked: filters.value.length === 0, keepOpen: true, action: () => setFilters([]) },
  { label: "", separator: true },
  ...GROUPS.map((group) => ({
    label: $t(`requests.filter.${group}`),
    checked: filters.value.includes(group),
    keepOpen: true,
    action: () => setFilters(filters.value.includes(group) ? filters.value.filter((g) => g !== group) : [...filters.value, group])
  }))
]);

const filterLabel = computed(() => filters.value.length === 0
  ? $t('requests.filter.title')
  : `${$t('requests.filter.title')}: ${filters.value.map((group) => $t(`requests.filter.${group}`)).join(", ")}`);

function setFilters(next: Group[]) {
  filters.value = next.length === GROUPS.length ? [] : next;
  void reset();
}

function openFilter(e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  filterMenu.value?.openAt(rect.left, rect.bottom + 4);
}

// the accept/deny/delete buttons depend on what the viewer may do; load that before the rows render
await useCurrentUser().ensureLoaded();

function onDeleted(id: string) {
  requests.value = requests.value.filter((r) => r.id !== id);
}
</script>

<style>
.req-head {
  display: flex;
  align-items: center;
  gap: 14px;
}

.req-head .filter-btn {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid #ffffffae;
  border-radius: 50%;
  color: #ffffffae;
  transition: background 0.2s ease-out, color 0.2s ease-out;
}

.req-head .filter-btn:hover,
.req-head .filter-btn.active {
  background: #ffffffae;
  color: #000;
}

.req-head .filter-btn .count {
  position: absolute;
  top: -6px;
  right: -6px;
  min-width: 18px;
  height: 18px;
  padding: 0 4px;
  border-radius: 9px;
  background: #ffffff;
  color: #000;
  border: 1px solid #000;
  font-family: var(--font-discy);
  font-size: 0.55em;
  font-weight: 700;
  display: flex;
  align-items: center;
  justify-content: center;
}

.reqs {
  margin: 20px 0;
}

.reqs > * {
  margin: 10px 0;
}

.scroll-sentinel {
  height: 1px;
}

.loading-more {
  text-align: center;
  color: #666666;
  font-size: 0.8em;
  padding: 10px 0;
}

.err p {
  text-align: center;
  margin: 50px 0;
  font-size: 1.35em;
}
</style>