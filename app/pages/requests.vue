<template>
  <div class="requests">
    <div class="req-head">
      <h1>{{ $t('requests.title') }}</h1>
      <button type="button" class="filter-btn" :class="{ active: activeFilterCount > 0 }" aria-haspopup="menu" :title="$t('requests.filter.title')" :aria-label="filterLabel" @click="openFilter">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 5h18l-7 8v6l-4-2v-4z" /></svg>
        <span v-if="activeFilterCount > 0" class="count">{{ activeFilterCount }}</span>
      </button>
    </div>
    <ContextMenu ref="filterMenu" :items="filterItems" />
    <div class="reqs" v-if="requests.length > 0">
      <RequestRow v-for="req in requests" :key="req.id" :request="req" :is-compact="false" @deleted="onDeleted" />
    </div>
    <div class="err" v-else-if="!initialLoading">
      <p>{{ $t('requests.empty') }}</p>
    </div>
    <LoadError :error="listError" />
    <div ref="sentinel" class="scroll-sentinel" />
    <p class="loading-more" v-if="loadingMore">{{ $t('common.loadingMore') }}</p>
  </div>
</template>

<script lang="ts" setup>
import ContextMenu, { type ContextMenuItem } from '~/components/ContextMenu.vue';
import RequestRow from '~/components/RequestRow.vue';
import type { NafynRequest } from '~~/server/entity/NafynRequest';
import { useAuthToken } from '~/composables/useAuthToken';
import { Permission } from '~~/server/entity/Permission';

const { token } = useAuthToken();

// The groups the list is narrowed to (GET /api/v1/requests takes `<group>=false` for each one left out). Nothing
// selected is the "All" filter; "All" excludes the others, and picking every group is the same as All.
const GROUPS = ["succeeded", "failed", "waiting", "processing"] as const;
type Group = typeof GROUPS[number];
const filters = ref<Group[]>([]);
// one request type (`type=album|track`) and, for managers, one requester (`user=<id>`); null = all of them
const typeFilter = ref<"album" | "track" | null>(null);
const userFilter = ref<string | null>(null);

interface Requester { id: string, username: string, displayName: string | null }

// the accept/deny/delete buttons depend on what the viewer may do; load that before the rows render
const currentUser = useCurrentUser();
await currentUser.ensureLoaded();
// only managers see other people's requests, so only they get the "Requested by" filter
const canFilterByUser = computed(() => currentUser.can(Permission.MANAGE_REQUESTS));

function filterQuery(): Record<string, string> {
  const query: Record<string, string> = {};
  if (filters.value.length > 0) {
    for (const group of GROUPS) if (!filters.value.includes(group)) query[group] = "false";
  }
  if (typeFilter.value) query.type = typeFilter.value;
  if (userFilter.value) query.user = userFilter.value;
  return query;
}

const { items: requests, error: listError, initialLoading, loadingMore, sentinel, loadMore, reset } = useInfiniteList<NafynRequest>((page, limit) => {
  return token.value
    ? $fetch("/api/v1/requests", { headers: { Authorization: token.value }, query: { page, limit, ...filterQuery() } })
    : Promise.resolve({ items: [], page, limit, total: 0, hasMore: false });
});
await loadMore();

// the people who made a request, fetched the first time the filter opens (silent on failure: the menu then simply
// has no "Requested by")
const requesters = ref<Requester[]>([]);
let requestersLoaded = false;
async function loadRequesters() {
  if (requestersLoaded || !canFilterByUser.value || !token.value) return;
  requestersLoaded = true;
  try {
    requesters.value = await $fetch<Requester[]>("/api/v1/requests/requesters", { headers: { Authorization: token.value } });
  } catch {
    requestersLoaded = false;
  }
}

const filterMenu = ref<InstanceType<typeof ContextMenu> | null>(null);

const activeFilterCount = computed(() => filters.value.length + (typeFilter.value ? 1 : 0) + (userFilter.value ? 1 : 0));

function requesterName(user: Requester): string {
  return user.displayName || user.username;
}

const filterItems = computed<ContextMenuItem[]>(() => {
  const items: ContextMenuItem[] = [
    { label: $t('requests.filter.all'), checked: activeFilterCount.value === 0, keepOpen: true, action: clearFilters },
    { label: "", separator: true },
    ...GROUPS.map((group) => ({
      label: $t(`requests.filter.${group}`),
      checked: filters.value.includes(group),
      keepOpen: true,
      action: () => setFilters(filters.value.includes(group) ? filters.value.filter((g) => g !== group) : [...filters.value, group])
    })),
    { label: "", separator: true },
    {
      label: $t('requests.filter.type'),
      children: [
        { label: $t('requests.filter.allTypes'), checked: typeFilter.value === null, keepOpen: true, action: () => setType(null) },
        { label: $t('requests.filter.albums'), checked: typeFilter.value === "album", keepOpen: true, action: () => setType("album") },
        { label: $t('requests.filter.tracks'), checked: typeFilter.value === "track", keepOpen: true, action: () => setType("track") }
      ]
    }
  ];
  if (canFilterByUser.value && requesters.value.length > 0) {
    items.push({
      label: $t('requests.filter.requestedBy'),
      children: [
        { label: $t('requests.filter.everyone'), checked: userFilter.value === null, keepOpen: true, action: () => setUser(null) },
        ...requesters.value.map((user) => ({
          label: user.id === currentUser.user.value?.id ? $t('requests.filter.you', { name: requesterName(user) }) : requesterName(user),
          checked: userFilter.value === user.id,
          keepOpen: true,
          action: () => setUser(user.id)
        }))
      ]
    });
  }
  return items;
});

const filterLabel = computed(() => {
  if (activeFilterCount.value === 0) return $t('requests.filter.title');
  const parts = filters.value.map((group) => $t(`requests.filter.${group}`));
  if (typeFilter.value) parts.push($t(typeFilter.value === "album" ? 'requests.filter.albums' : 'requests.filter.tracks'));
  const user = requesters.value.find((r) => r.id === userFilter.value);
  if (user) parts.push(requesterName(user));
  return `${$t('requests.filter.title')}: ${parts.join(", ")}`;
});

function setFilters(next: Group[]) {
  filters.value = next.length === GROUPS.length ? [] : next;
  void reset();
}

function setType(next: "album" | "track" | null) {
  if (typeFilter.value === next) return;
  typeFilter.value = next;
  void reset();
}

function setUser(next: string | null) {
  if (userFilter.value === next) return;
  userFilter.value = next;
  void reset();
}

function clearFilters() {
  if (activeFilterCount.value === 0) return;
  filters.value = [];
  typeFilter.value = null;
  userFilter.value = null;
  void reset();
}

async function openFilter(e: MouseEvent) {
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  await loadRequesters();
  filterMenu.value?.openAt(rect.left, rect.bottom + 4);
}

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
  color: var(--tint-fg, #ffffffae);
  font-size: 0.8em;
  padding: 10px 0;
}

.err p {
  text-align: center;
  margin: 50px 0;
  font-size: 1.35em;
}
</style>