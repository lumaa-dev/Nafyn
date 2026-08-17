<template>
  <div class="reqrow" v-if="props.request.info != null">
    <div class="reqrow-main">
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
          <span class="data" v-if="!isCompact">
            <p v-if="typeof props.request.requestedBy != 'string'">{{ $t('requests.requestedBy', { name: props.request.requestedBy.displayName ?? props.request.requestedBy.username }) }}</p>
            <p>{{ $t('requests.createdOn', { date: formatDate(props.request.createdAt) }) }}</p>
            <p>{{ $t('requests.updatedOn', { date: formatDate(props.request.updatedAt) }) }}</p>
          </span>
        </div>  
        <div class="col" v-if="!isCompact">
          <span>
            <p :filled="liveStatus == 'waiting' ? 'hollow' : ''" :class="`status ${liveStatus}`">{{ $t(`requests.status.${liveStatus}`) }}</p>
          </span>
        </div>
      </div>
    </div>

    <div class="progress" v-if="!isCompact && progress">
      <div class="bar">
        <div
          class="fill"
          :class="{ indeterminate: progressPercent === null && liveStatus !== 'completed' }"
          :style="progressPercent !== null ? { width: `${progressPercent}%` } : {}"
        />
      </div>
      <span class="stats">
        <span v-if="progressPercent !== null">{{ Math.round(progressPercent) }}%</span>
        <span v-if="progress.speedBytesPerSec">{{ formatSpeed(progress.speedBytesPerSec) }}</span>
        <span v-if="progress.etaSeconds != null">{{ $t('requests.progress.eta', { time: formatEta(progress.etaSeconds) }) }}</span>
        <span v-if="progress.trackCount && progress.trackCount > 1">{{ $t('requests.progress.track', { index: (progress.trackIndex ?? 0) + 1, count: progress.trackCount }) }}</span>
        <span v-if="progress.message" class="message">{{ progress.message }}</span>
      </span>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { NafynRequest, RequestStatus } from '~~/server/entity/NafynRequest';

interface DownloadProgressEvent {
  requestId: string;
  stage: RequestStatus;
  trackTitle?: string;
  trackIndex?: number;
  trackCount?: number;
  bytesDownloaded?: number;
  totalBytes?: number;
  speedBytesPerSec?: number;
  etaSeconds?: number | null;
  message?: string;
}

const props = defineProps<{ request: NafynRequest, isCompact: boolean; }>();

const { locale } = useI18n();

function formatDate(date: string | Date): string {
  return new Date(date).toLocaleDateString(locale.value, { year: "numeric", month: "long", day: "numeric", hour: '2-digit', minute: '2-digit' });
}

function formatSpeed(bytesPerSec: number): string {
  return `${formatBytes(bytesPerSec)}/s`;
}

function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

function formatEta(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = Math.floor(seconds % 60);
  return `${minutes}:${rest.toString().padStart(2, "0")}`;
}

// live progress over the /ws/downloads socket; only the requesting user can subscribe (server-enforced),
// so connection attempts by other viewers are simply closed and ignored
const liveStatus = ref<RequestStatus>(props.request.status);
const progress = ref<DownloadProgressEvent | null>(null);

const progressPercent = computed(() => {
  const p = progress.value;
  if (!p || !p.totalBytes) return null;
  return Math.min(100, (p.bytesDownloaded ?? 0) / p.totalBytes * 100);
});

const TERMINAL_STAGES: RequestStatus[] = ["completed", "failed"];

let socket: WebSocket | null = null;

function connect() {
  // "waiting" requests haven't started processing yet, but they will - stay connected so the very first
  // "searching" event (and everything after) arrives live instead of requiring a manual page refresh
  if (import.meta.server || socket || TERMINAL_STAGES.includes(liveStatus.value)) return;

  const token = useCookie("nafynToken").value;
  if (!token) return;

  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${wsProtocol}//${location.host}/ws/downloads?requestId=${props.request.id}&token=${encodeURIComponent(token)}`;

  socket = new WebSocket(url);
  socket.addEventListener("message", (e) => {
    const event = JSON.parse(e.data) as DownloadProgressEvent;
    progress.value = event;
    liveStatus.value = event.stage;

    if (event.stage === "completed" || event.stage === "failed") {
      disconnect();
    }
  });
}

function disconnect() {
  socket?.close();
  socket = null;
}

onMounted(connect);
onUnmounted(disconnect);
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
  flex-direction: column;
  gap: 20px;
  font-size: 1.2em;
  padding: 35px;
  border-radius: 20px;
  background: #00000050;
}

.reqrow-main {
  display: flex;
  flex-direction: row;
  gap: 20px;
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
  font-family: "Discy";
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

.reqrow .progress {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.reqrow .bar {
  width: 100%;
  height: 8px;
  border-radius: 4px;
  background: #ffffff1a;
  overflow: hidden;
}

.reqrow .bar .fill {
  height: 100%;
  border-radius: 4px;
  background: #e18c46;
  transition: width 0.3s ease;
}

.reqrow .bar .fill.indeterminate {
  width: 35%;
  animation: reqrow-indeterminate 1.2s ease-in-out infinite;
}

@keyframes reqrow-indeterminate {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(285%); }
}

.reqrow .stats {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  font-family: "Discy";
  font-size: 0.6em;
  color: #666666;
}

.reqrow .stats .message {
  font-style: italic;
}

@media screen and (max-width: 800px) {
  .reqrow {
    font-size: 1.0em;
  }

  .reqrow-main {
    flex-direction: column;
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