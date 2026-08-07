<template>
  <div class="reqrow" v-if="props.request.info != null">
    <div class="colssm" style="gap: 25px">
      <img :src="props.request.info.coverArt" v-if="props.request.info.coverArt" loading="lazy" draggable="false" />
      <span class="info small">
        <p class="title">{{ props.request.info.title }}</p>
        <p class="artist">{{ props.request.info.artist }}</p>
      </span>
    </div>
    <div class="cols">
      <div class="col">
        <span class="info big">
          <p class="title">{{ props.request.info.title }}</p>
          <p class="artist">{{ props.request.info.artist }}</p>
        </span>
        <span class="data">
          <p v-if="typeof props.request.requestedBy != 'string'">{{ $t('requests.requestedBy', { name: props.request.requestedBy.displayName ?? props.request.requestedBy.username }) }}</p>
          <p>{{ $t('requests.createdOn', { date: formatDate(props.request.createdAt) }) }}</p>
          <p>{{ $t('requests.updatedOn', { date: formatDate(props.request.updatedAt) }) }}</p>
        </span>
      </div>
      <div class="col">
        <span>
          <p :filled="props.request.status == 'waiting' ? 'hollow' : ''" :class="`status ${props.request.status}`">{{ $t(`requests.status.${props.request.status}`) }}</p>
        </span>
      </div>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { NafynRequest } from '~~/server/entity/NafynRequest';

const props = defineProps<{ request: NafynRequest, isCompact: boolean; }>();

const { locale } = useI18n();

function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString(locale.value, { year: "numeric", month: "long", day: "numeric", hour: '2-digit', minute: '2-digit' });
}
</script>

<style>
.small {
  display: none;
}

.big {
  display: initial;
}

.reqrow {
  display: flex;
  flex-direction: row;
  gap: 20px;
  font-size: 1.2em;
  padding: 35px;
  border-radius: 20px;
  background: #00000050;
}

.reqrow img {
  border-radius: 5px;
  width: 100px;
  height: 100px;
  aspect-ratio: 1 / 1;
}

.reqrow .cols {
  display: flex;
  flex-direction: row;
  justify-content: space-between;
  width: 100%;
}

.reqrow .col {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.reqrow .info .title {
  font-size: 1.1em;
}

.reqrow .data {
  font-family: system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, 'Open Sans', 'Helvetica Neue', sans-serif;
  font-size: 0.6em;
  padding: 20px 0 0 0;
  font-style: italic;
}

.reqrow .info .artist {
  font-size: 0.9em;
}

.reqrow .info .artist, .reqrow .data {
  color: #666666;
}

.reqrow .status {
  font-size: 0.8em;
  padding: 0.5em 1.2em;
  text-transform: capitalize;
  border: none;
}

.reqrow .status.completed {
  background: #44cf44;
  color: #ffffffae;
}

.reqrow .status.waiting {
  border: #e4d93e 1px solid;
}

.reqrow .status.searching, .reqrow .status.downloading, .reqrow .status.processing {
  background: #e18c46;
  color: #ffffffae;
}

.reqrow .status.failed {
  background: #cf4444;
  color: #ffffffae;
}

@media screen and (max-width: 800px) {
  .reqrow {
    flex-direction: column;
    font-size: 1.0em;
  }

  .small {
    display: initial;
  }

  .big {
    display: none;
  }

  .reqrow .colssm {
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    width: 100%;
  }
}
</style>