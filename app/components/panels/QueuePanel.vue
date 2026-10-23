<template>
  <div ref="scroller" class="queue-panel np-quiet-scroll" :style="{ '--panel-height': `${panelHeight}px` }">
    <!-- oldest at the top, latest right above the Queue heading: scrolling up from the queue walks back in time -->
    <ol v-if="historyItems.length > 0" class="tracks history" :aria-label="$t('player.history')">
      <li
        v-for="(track, i) in historyItems"
        :key="`${i}-${track.id}`"
        tabindex="0"
        @click="playFromHistory(i, track.id)"
        @keydown.enter.prevent="playFromHistory(i, track.id)"
        @keydown.space.prevent="playFromHistory(i, track.id)"
      >
        <CoverImage :src="coverSrc(track)" />
        <span class="col">
          <span class="title">{{ track.title }}</span>
          <span class="artist">{{ track.artistName }}</span>
        </span>
      </li>
    </ol>

    <h2 class="heading">{{ $t('player.queue') }}</h2>

    <!-- at least one panel tall, so the panel can always open scrolled to the controls with the history above -->
    <div class="body">
      <span ref="controls" class="controls">
        <button :filled="state.repeat !== 'off' ? '' : 'hollow'" @click="cycleRepeat()">{{ repeatTitle }}</button>
        <button filled="hollow" disabled>{{ $t('player.shuffle') }}</button>
      </span>

      <p v-if="displayed.length === 0" class="empty">{{ $t('player.queueEmpty') }}</p>
      <ol v-else ref="list" class="tracks upcoming" :aria-label="$t('player.queue')" :aria-describedby="hintId">
        <li
          v-for="(entry, pos) in displayed"
          :key="`${entry.index}-${entry.track.id}`"
          :data-queue-pos="pos"
          :class="{ dragging: preview !== null && pos === dragPos }"
          tabindex="0"
          @pointerdown="onRowPointerDown($event, pos)"
          @contextmenu.prevent
          @click="onRowClick(entry)"
          @keydown="onRowKeydown($event, entry, pos)"
        >
          <CoverImage :src="coverSrc(entry.track)" />
          <span class="col">
            <span class="title">{{ entry.track.title }}</span>
            <span class="artist">{{ entry.track.artistName }}</span>
          </span>
          <button filled="hollow" class="round" :aria-label="$t('player.removeFromQueue')" :title="$t('player.removeFromQueue')" @click.stop="removeFromQueue(entry.index, entry.track.id)">&times;</button>
        </li>
      </ol>
      <p :id="hintId" class="visually-hidden">{{ $t('player.queueHint') }}</p>
    </div>
  </div>
</template>

<script lang="ts" setup>
import type { MediaRow } from '~~/server/core/library';
import { useHistoryEnabled } from '~/composables/usePlayTracking';

interface QueueEntry {
  track: MediaRow;
  /** index in state.queue */
  index: number;
}

const { t } = useI18n();
const { state, playFromQueue, playFromHistory, removeFromQueue, moveInQueue, cycleRepeat } = useUnity();
const historyEnabled = useHistoryEnabled();
// unique per instance: the page panel and the player bar's dropdown can both be mounted
const hintId = useId();

const repeatTitle = computed(() => {
  switch (state.value.repeat) {
    case "queue": return t("player.repeat");
    case "track": return t("player.repeatOne");
    default: return t("player.repeatOff");
  }
});

// the History follows the account's "Listening history" setting (Settings -> Privacy)
const historyItems = computed<MediaRow[]>(() => historyEnabled.value ? state.value.history ?? [] : []);

// the queue is what plays after the current track - the current track itself is not part of it
const upcoming = computed<QueueEntry[]>(() => {
  const start = state.value.currentIndex + 1;
  return state.value.queue.slice(start).map((track, i) => ({ track, index: start + i }));
});

// -- scroll position --

const scroller = ref<HTMLElement | null>(null);
const controls = ref<HTMLElement | null>(null);
const list = ref<HTMLOListElement | null>(null);
const panelHeight = ref(0);

function anchorTop(): number {
  return controls.value?.offsetTop ?? 0;
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  const el = scroller.value;
  if (!el) return;
  // capped by the container and the viewport: in a parent without a definite height this element grows with its
  // content, and an uncapped spacer would then grow it again on every resize, forever
  const measure = () => {
    panelHeight.value = Math.min(el.clientHeight, el.parentElement?.clientHeight ?? Infinity, window.innerHeight);
  };
  measure();
  resizeObserver = new ResizeObserver(measure);
  resizeObserver.observe(el);
  // opens on the controls and the upcoming tracks; the heading and the history are above, a scroll up away
  nextTick(() => { el.scrollTop = anchorTop(); });
});

// a track entering the history grows the content above the queue - keep the queue where it was on screen
// rather than letting everything slide down by one row
watch(() => historyItems.value.length, () => {
  const el = scroller.value;
  if (!el) return;
  const offset = el.scrollTop - anchorTop();
  nextTick(() => { el.scrollTop = anchorTop() + offset; });
}, { flush: "pre" });

// -- drag and drop --
//
// Same approach as the playlist page: pointer events (mouse and touch alike), the row under the pointer found
// with elementFromPoint, and a local copy of the order spliced live while dragging, committed on release.
// The whole row is the handle: a mouse drag starts after a few pixels of movement, a touch drag after a long
// press - a touch that moves before then is a scroll.

const LONG_PRESS_MS = 350;
const MOUSE_DRAG_THRESHOLD_PX = 5;
const TOUCH_SLOP_PX = 8;
const AUTOSCROLL_EDGE_PX = 40;
const AUTOSCROLL_STEP_PX = 8;

const preview = ref<QueueEntry[] | null>(null);
const dragPos = ref(-1);
const displayed = computed<QueueEntry[]>(() => preview.value ?? upcoming.value);

let press: { x: number, y: number, pos: number, mouse: boolean, timer: ReturnType<typeof setTimeout> | null } | null = null;
let draggedEntry: QueueEntry | null = null;
let pointer = { x: 0, y: 0 };
let autoscrollFrame: number | null = null;
let suppressClick = false;

function onRowPointerDown(e: PointerEvent, pos: number) {
  if (e.button !== 0 || (e.target as HTMLElement).closest("button")) return;
  endPress();

  press = { x: e.clientX, y: e.clientY, pos, mouse: e.pointerType === "mouse", timer: null };
  pointer = { x: e.clientX, y: e.clientY };
  if (!press.mouse) press.timer = setTimeout(startDrag, LONG_PRESS_MS);

  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", endPress);
  // non-passive, so a touch drag can stop the panel from scrolling under the finger
  window.addEventListener("touchmove", onTouchMove, { passive: false });
}

function startDrag() {
  if (!press) return;
  const entries = [...upcoming.value];
  draggedEntry = entries[press.pos] ?? null;
  if (!draggedEntry) return;

  preview.value = entries;
  dragPos.value = press.pos;
  document.body.style.cursor = "grabbing";
  autoscrollFrame = requestAnimationFrame(autoscroll);
}

function onPointerMove(e: PointerEvent) {
  if (!press) return;
  pointer = { x: e.clientX, y: e.clientY };

  if (preview.value === null) {
    const distance = Math.hypot(e.clientX - press.x, e.clientY - press.y);
    if (press.mouse && distance > MOUSE_DRAG_THRESHOLD_PX) startDrag();
    else if (!press.mouse && distance > TOUCH_SLOP_PX) endPress();
    if (preview.value === null) return;
  }

  moveOver(e.clientX, e.clientY);
}

function onTouchMove(e: TouchEvent) {
  if (preview.value !== null) e.preventDefault();
}

function moveOver(x: number, y: number) {
  const entries = preview.value;
  if (!entries) return;
  const li = document.elementFromPoint(x, y)?.closest("li[data-queue-pos]") as HTMLElement | null;
  if (!li || !list.value?.contains(li)) return;

  const overPos = Number(li.dataset.queuePos);
  if (Number.isNaN(overPos) || overPos === dragPos.value) return;

  const [moved] = entries.splice(dragPos.value, 1);
  entries.splice(overPos, 0, moved!);
  dragPos.value = overPos;
}

// keeps scrolling while the pointer rests near an edge of the panel, so a track can be dragged past what's visible
function autoscroll() {
  const el = scroller.value;
  if (!el || preview.value === null) return;

  const rect = el.getBoundingClientRect();
  if (pointer.y < rect.top + AUTOSCROLL_EDGE_PX) el.scrollTop -= AUTOSCROLL_STEP_PX;
  else if (pointer.y > rect.bottom - AUTOSCROLL_EDGE_PX) el.scrollTop += AUTOSCROLL_STEP_PX;
  moveOver(pointer.x, pointer.y);

  autoscrollFrame = requestAnimationFrame(autoscroll);
}

function onPointerUp() {
  if (preview.value !== null && draggedEntry) {
    const to = state.value.currentIndex + 1 + dragPos.value;
    if (to !== draggedEntry.index) moveInQueue(draggedEntry.index, to, draggedEntry.track.id);
    // the click that follows this pointerup belongs to the drag, not to "play this track"
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
  }
  endPress();
}

function endPress() {
  if (press?.timer) clearTimeout(press.timer);
  press = null;
  draggedEntry = null;
  preview.value = null;
  dragPos.value = -1;
  if (autoscrollFrame !== null) cancelAnimationFrame(autoscrollFrame);
  autoscrollFrame = null;
  document.body.style.cursor = "";

  window.removeEventListener("pointermove", onPointerMove);
  window.removeEventListener("pointerup", onPointerUp);
  window.removeEventListener("pointercancel", endPress);
  window.removeEventListener("touchmove", onTouchMove);
}

onUnmounted(() => {
  endPress();
  resizeObserver?.disconnect();
});

function onRowClick(entry: QueueEntry) {
  if (suppressClick) return;
  playFromQueue(entry.index);
}

// keyboard equivalent of dragging: Alt + Up/Down moves the focused track, Delete removes it
function onRowKeydown(e: KeyboardEvent, entry: QueueEntry, pos: number) {
  if (e.target !== e.currentTarget) return;

  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    playFromQueue(entry.index);
    return;
  }
  if (e.key === "Delete" || e.key === "Backspace") {
    e.preventDefault();
    removeFromQueue(entry.index, entry.track.id);
    nextTick(() => focusRow(Math.min(pos, upcoming.value.length - 1)));
    return;
  }
  if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const target = pos + (e.key === "ArrowUp" ? -1 : 1);
    if (target < 0 || target >= upcoming.value.length) return;
    moveInQueue(entry.index, entry.index - pos + target, entry.track.id);
    nextTick(() => focusRow(target));
  }
}

function focusRow(pos: number) {
  (list.value?.querySelector(`[data-queue-pos="${pos}"]`) as HTMLElement | null)?.focus();
}
</script>

<style scoped>
.queue-panel {
  position: relative;
  height: 100%;
  overflow-y: auto;
  /* the history above is kept in place by hand (see the watcher), the browser must not adjust on top of it */
  overflow-anchor: none;
  color: var(--np-text, #ffffff);
}

.queue-panel .heading {
  font-size: 0.9em;
  margin: 14px 8px 0;
}

.queue-panel .body {
  min-height: var(--panel-height, 100%);
}

.queue-panel .controls {
  display: flex;
  flex-direction: row;
  gap: 10px;
  width: 100%;
  padding: 10px 0;
}

.queue-panel .controls button {
  flex: 1 1 0;
  min-width: 0;
}

.queue-panel .tracks {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.queue-panel .tracks li {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 12px;
  padding: 8px;
  border-radius: 8px;
  cursor: pointer;
  /* a long press starts a drag on touch: no text selection or callout getting in the way */
  user-select: none;
  -webkit-user-select: none;
  -webkit-touch-callout: none;
}

/* highlights follow the surface's text colour (white on a dark cover, black on a light one): a fixed white tint
   is invisible on a light backdrop */
.queue-panel .tracks li:hover {
  background: color-mix(in srgb, var(--np-text, #ffffff) 10%, transparent);
}

.queue-panel .tracks li:focus-visible {
  outline: 2px solid var(--np-text, #ffffff);
  outline-offset: 2px;
}

.queue-panel .upcoming li.dragging {
  background: color-mix(in srgb, var(--np-text, #ffffff) 20%, transparent);
  cursor: grabbing;
}

.queue-panel .tracks li img {
  width: 45px;
  height: 45px;
  aspect-ratio: 1 / 1;
  border-radius: 5px;
  background: #00000040;
  flex-shrink: 0;
  pointer-events: none;
}

.queue-panel .col {
  display: flex;
  flex-direction: column;
  flex: 1;
  overflow: hidden;
}

.queue-panel .title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-panel .artist {
  font-size: 0.85em;
  color: color-mix(in srgb, var(--np-text, #ffffff) 85%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.queue-panel .round {
  width: max(2em, 44px);
  height: max(2em, 44px);
  border-radius: 50%;
  padding: 0 !important;
  font-size: 1em;
  line-height: 1;
  flex-shrink: 0;
}

.queue-panel .empty {
  color: color-mix(in srgb, var(--np-text, #ffffff) 85%, transparent);
  text-align: center;
  padding: 8px;
}

.queue-panel .visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media screen and (max-width: 800px) {
  .queue-panel .controls button {
    font-size: 0.7em;
  }
}
</style>
