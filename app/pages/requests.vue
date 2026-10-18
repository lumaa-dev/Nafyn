<template>
  <div class="requests">
    <h1>{{ $t('requests.title') }}</h1>
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
import RequestRow from '~/components/RequestRow.vue';
import type { NafynRequest } from '~~/server/entity/NafynRequest';
import { useAuthToken } from '~/composables/useAuthToken';

const { token } = useAuthToken();

const { items: requests, initialLoading, loadingMore, sentinel, loadMore } = useInfiniteList<NafynRequest>((page, limit) => {
  return token.value
    ? $fetch("/api/v1/requests", { headers: { Authorization: token.value }, query: { page, limit } })
    : Promise.resolve({ items: [], page, limit, total: 0, hasMore: false });
});
await loadMore();

// the accept/deny/delete buttons depend on what the viewer may do; load that before the rows render
await useCurrentUser().ensureLoaded();

function onDeleted(id: string) {
  requests.value = requests.value.filter((r) => r.id !== id);
}
</script>

<style>
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