<template>
  <div class="requests">
    <h1>{{ $t('requests.title') }}</h1>
    <div class="reqs" v-if="requests.length > 0">
      <RequestRow v-for="req in requests" :key="req.id" :request="req" :is-compact="false" />
    </div>
    <div class="err" v-else>
      <p>{{ $t('requests.empty') }}</p>
    </div>
  </div>
</template>

<script lang="ts" setup>
import RequestRow from '~/components/RequestRow.vue';
import type { NafynRequest } from '~~/server/entity/NafynRequest';

const token = useCookie("nafynToken").value;

const { data: requests } = await useAsyncData<NafynRequest[]>("requests-list", () => {  
  return token
    ? $fetch("/api/v1/requests", { headers: { Authorization: token } })
    : Promise.resolve([]);
}, { default: () => [] });
</script>

<style>
.reqs {
  margin: 20px 0;
}

.reqs > * {
  margin: 10px 0;
}

.err p {
  text-align: center;
  margin: 50px 0;
  font-size: 1.35em;
}
</style>