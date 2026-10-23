<template>
  <img
    ref="root"
    :src="shown"
    :alt="alt"
    :class="{ 'cover-pending': !ready, 'cover-fresh': fresh }"
    :fetchpriority="eager ? 'high' : undefined"
    decoding="async"
    draggable="false"
    @error="onEagerError"
  />
</template>

<script lang="ts">
import noCover from "~/assets/no-cover.png";

// One observer and one small download queue for every CoverImage on the page: a library grid of two hundred
// covers must neither start two hundred requests at once (the first screen's covers would queue behind the
// rest) nor load anything far off-screen.
const MAX_CONCURRENT = 6;
const LOAD_TIMEOUT_MS = 10_000;
const RETRY_DELAYS_MS = [2_500, 6_000];

let active = 0;
const waiting: (() => void)[] = [];

function acquire(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      active++;
      let released = false;
      resolve(() => {
        if (released) return;
        released = true;
        active--;
        waiting.shift()?.();
      });
    };
    if (active < MAX_CONCURRENT) grant();
    else waiting.push(grant);
  });
}

const visibleCallbacks = new WeakMap<Element, () => void>();
let sharedObserver: IntersectionObserver | null = null;

function observe(el: Element, onVisible: () => void) {
  if (!sharedObserver) {
    sharedObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        sharedObserver?.unobserve(entry.target);
        visibleCallbacks.get(entry.target)?.();
        visibleCallbacks.delete(entry.target);
      }
    }, { rootMargin: "300px 0px" });
  }
  visibleCallbacks.set(el, onVisible);
  sharedObserver.observe(el);
}

function unobserve(el: Element) {
  visibleCallbacks.delete(el);
  sharedObserver?.unobserve(el);
}
</script>

<script lang="ts" setup>
// A drop-in <img> for any cover. The placeholder is on screen immediately; the real image is fetched only once it
// is (nearly) in view, through Nafyn's cache for Cover Art Archive covers (see coverArtUrl), and swapped in with a
// short fade when it has arrived - so a slow cover leaves the placeholder, never a blank square, and a cover that
// never comes (archive down, no such cover) just stays the placeholder instead of a broken image.
const props = withDefaults(defineProps<{
  src?: string | null,
  size?: 250 | 500 | 1000,
  // above the fold (the hero cover of a page): no observer, no queue, the browser starts it right away
  eager?: boolean,
  alt?: string
}>(), { src: null, size: undefined, eager: false, alt: "" });

const resolved = computed(() => coverArtUrl(props.src, props.size));
const hasRealCover = computed(() => resolved.value !== noCover);

// eager covers are server-rendered with their real source; the rest start as the placeholder
const shown = ref<string>(props.eager ? resolved.value : noCover);
const ready = ref(props.eager || !hasRealCover.value);
const fresh = ref(false);

const root = ref<HTMLImageElement | null>(null);
let generation = 0;
let started = false;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let freshTimer: ReturnType<typeof setTimeout> | null = null;

function reveal(url: string) {
  shown.value = url;
  ready.value = true;
  fresh.value = true;
  if (freshTimer) clearTimeout(freshTimer);
  freshTimer = setTimeout(() => { fresh.value = false; }, 400);
}

async function load(url: string, attempt: number, token: number) {
  const release = await acquire();
  if (token !== generation) { release(); return; }

  const probe = new Image();
  probe.decoding = "async";

  const settle = (ok: boolean) => {
    probe.onload = probe.onerror = null;
    clearTimeout(timeout);
    release();
    if (token !== generation) return;
    if (ok) { reveal(url); return; }

    // a cold cover answers "not yet" while the cache is still fetching it: try again a couple of times
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) retryTimer = setTimeout(() => load(url, attempt + 1, token), delay);
  };

  const timeout = setTimeout(() => { probe.src = ""; settle(false); }, LOAD_TIMEOUT_MS);
  probe.onload = () => settle(true);
  probe.onerror = () => settle(false);
  probe.src = url;
}

function start() {
  started = true;
  if (!hasRealCover.value || props.eager) return;
  load(resolved.value, 0, generation);
}

// an eager cover is the browser's to load; if it fails, fall back to the placeholder like everything else
function onEagerError() {
  if (props.eager && shown.value !== noCover) {
    shown.value = noCover;
    ready.value = true;
  }
}

function reset() {
  generation++;
  if (retryTimer) clearTimeout(retryTimer);
  fresh.value = false;
  shown.value = props.eager ? resolved.value : noCover;
  ready.value = props.eager || !hasRealCover.value;
  if (started) start();
}

watch(resolved, reset);

onMounted(() => {
  if (!root.value || props.eager) { started = true; return; }
  observe(root.value, start);
});

onBeforeUnmount(() => {
  generation++;
  if (retryTimer) clearTimeout(retryTimer);
  if (freshTimer) clearTimeout(freshTimer);
  if (root.value) unobserve(root.value);
});
</script>

<style>
/* the placeholder is the app's own no-cover image on the usual translucent backdrop; the pulse says "still coming" */
img.cover-pending {
  animation: cover-pending 1.6s ease-in-out infinite;
}

img.cover-fresh {
  animation: cover-in 0.3s ease-out;
}

@keyframes cover-pending {
  0%, 100% { opacity: 0.75; }
  50% { opacity: 1; }
}

@keyframes cover-in {
  from { opacity: 0.35; }
  to { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  img.cover-pending,
  img.cover-fresh {
    animation: none;
  }
}
</style>
