// animated mesh-gradient background driven by the current track's cover art, shared by NowPlaying.vue
// (mini player bar) and now-playing.vue (full page). Colors come from GET /api/v1/library/track/{id},
// which returns `imageColors` (dominant swatches, most-dominant first) and `textColor` (black/white,
// picked server-side for WCAG contrast against imageColors[0]).
const DEFAULT_COLORS = ["#2a2a2a", "#1c1c1c", "#333333", "#151515"];
const DEFAULT_TEXT = "#ffffff";
const BLOB_COUNT = 4;

interface TrackColors { imageColors: string[], textColor: string }
const colorCache = new Map<string, TrackColors>();

// per-blob motion profile: distinct speed/phase/orbit so the four blobs drift independently instead of
// moving in lockstep - kept fixed so only the music (via the bass pulse) changes the feel from track to track
const BLOB_MOTION = [
  { cx: 30, cy: 35, ampX: 22, ampY: 18, speed: 0.055, phase: 0 },
  { cx: 75, cy: 30, ampX: 18, ampY: 24, speed: 0.04, phase: 2.1 },
  { cx: 65, cy: 75, ampX: 24, ampY: 16, speed: 0.05, phase: 4.2 },
  { cx: 20, cy: 70, ampX: 16, ampY: 20, speed: 0.045, phase: 1.4 }
];

export function useCoverMeshGradient() {
  // useUnity(), not usePlayer(): on a slave device the real local engine never loads anything, so this must
  // follow the mirrored track (same one NowPlaying.vue/now-playing.vue actually display) or the colors would
  // never match what's on screen. getBassLevel() below stays tied to the real local analyser regardless -
  // it has no bass to report on a slave either way, so the gradient simply stops pulsing there, by design.
  const { state, currentTrack } = useUnity();

  const trackColors = ref<TrackColors>({ imageColors: [], textColor: DEFAULT_TEXT });

  async function loadColorsFor(mediaId: string) {
    const cached = colorCache.get(mediaId);
    if (cached) {
      trackColors.value = cached;
      return;
    }

    try {
      const token = useAuthToken().token.value ?? "";
      const data = await $fetch<TrackColors>(`/api/v1/library/track/${mediaId}`, { headers: { Authorization: token } });
      const result: TrackColors = { imageColors: data.imageColors, textColor: data.textColor };
      colorCache.set(mediaId, result);
      // only apply if the user hasn't already skipped to another track while this was in flight
      if (currentTrack.value?.id === mediaId) trackColors.value = result;
    } catch {
      // no cover, blocked fetch, transient error, ... - the default palette is a fine fallback
    }
  }

  watch(() => currentTrack.value?.id, (id) => {
    if (id) loadColorsFor(id);
    else trackColors.value = { imageColors: [], textColor: DEFAULT_TEXT };
  }, { immediate: true });

  const textColor = computed(() => trackColors.value.textColor || DEFAULT_TEXT);
  const onLightCover = computed(() => textColor.value === "#000000");
  // a fixed-contrast tint painted over the blobs (below the text) so legibility never depends on how
  // saturated/light the cover's dominant colors happen to be - the blobs stay visible through it, but
  // muted/gray text always sits on a controlled, consistent backdrop
  const scrimColor = computed(() => onLightCover.value ? "rgba(255, 255, 255, 0.55)" : "rgba(0, 0, 0, 0.6)");
  const inverseTextColor = computed(() => onLightCover.value ? "#ffffff" : "#000000");

  // Everything a cover-driven surface needs to stay AAA, bound once on its root (assets/css/immersive.css reads
  // it). Text AND controls follow the same black/white pick: the icon SVGs are black, so an icon that has to read
  // as --np-text is inverted when that is white (`--np-icon-fg`), and one that sits on a --np-text fill is
  // inverted when that fill is black (`--np-icon-inv`).
  const surfaceVars = computed(() => ({
    "--np-text": textColor.value,
    "--np-text-inverse": inverseTextColor.value,
    "--np-scrim": scrimColor.value,
    "--np-icon-fg": onLightCover.value ? "none" : "invert(1)",
    "--np-icon-inv": onLightCover.value ? "invert(1)" : "none"
  }));

  const bgColors = computed(() => {
    const colors = trackColors.value.imageColors.length > 0 ? trackColors.value.imageColors : DEFAULT_COLORS;
    return Array.from({ length: BLOB_COUNT }, (_, i) => colors[i % colors.length] ?? DEFAULT_COLORS[0]!);
  });

  const blobEls: (HTMLElement | null)[] = [];
  function setBlobRef(i: number) {
    return (el: Element | null) => { blobEls[i] = el as HTMLElement | null; };
  }

  let rafId: number | null = null;
  let smoothedBass = 0;
  let lastFrameMs = 0;
  let resizeObserver: ResizeObserver | null = null;
  // the blobs' container, in px: positions are written as transforms (compositor only, no layout, no repaint of
  // the blurred layers) instead of left/top percentages, which re-laid-out four large blurred elements per frame
  let boundsW = 0;
  let boundsH = 0;

  function measure() {
    const parent = blobEls.find(Boolean)?.parentElement;
    if (!parent) return;
    boundsW = parent.clientWidth;
    boundsH = parent.clientHeight;
  }

  function place(i: number, xPercent: number, yPercent: number, scale: number, opacity: number) {
    const el = blobEls[i];
    if (!el) return;
    el.style.transform = `translate3d(${(xPercent / 100) * boundsW}px, ${(yPercent / 100) * boundsH}px, 0) translate(-50%, -50%) scale(${scale})`;
    el.style.opacity = `${opacity}`;
  }

  function placeBlobsStatically() {
    measure();
    for (let i = 0; i < BLOB_COUNT; i++) {
      const motion = BLOB_MOTION[i];
      if (motion) place(i, motion.cx, motion.cy, 1, 0.8);
    }
  }

  // ~30 fps while the music plays (the pulse is the only fast thing here), ~10 while paused (the drift is
  // 0.04 rad/s - invisible between frames). Hidden tabs get no frames from the browser at all.
  const PLAYING_FRAME_MS = 33;
  const PAUSED_FRAME_MS = 100;

  function tick(timestampMs: number) {
    rafId = requestAnimationFrame(tick);

    const playing = state.value.isPlaying;
    if (timestampMs - lastFrameMs < (playing ? PLAYING_FRAME_MS : PAUSED_FRAME_MS)) return;
    lastFrameMs = timestampMs;

    const t = timestampMs / 1000;
    const targetBass = playing ? getBassLevel() : 0;
    // slow attack/release so the pulse reads as "breathing with the music" rather than flickering per-frame
    smoothedBass += (targetBass - smoothedBass) * 0.2;

    for (let i = 0; i < BLOB_COUNT; i++) {
      const motion = BLOB_MOTION[i];
      if (!motion) continue;

      const angle = t * motion.speed + motion.phase;
      const x = motion.cx + motion.ampX * Math.sin(angle);
      const y = motion.cy + motion.ampY * Math.cos(angle * 0.85 + motion.phase);
      place(i, x, y, 1 + smoothedBass * 0.22, 0.8 + smoothedBass * 0.2);
    }
  }

  function startLoop() {
    if (rafId !== null || !import.meta.client) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      placeBlobsStatically();
      return;
    }
    observeBounds();
    measure();
    rafId = requestAnimationFrame(tick);
  }

  function observeBounds() {
    const parent = blobEls.find(Boolean)?.parentElement;
    if (resizeObserver || !parent || !("ResizeObserver" in window)) return;
    resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(parent);
  }

  function stopLoop() {
    if (rafId !== null) cancelAnimationFrame(rafId);
    rafId = null;
    // the blobs are about to leave the DOM with the track; the next track brings new ones
    resizeObserver?.disconnect();
    resizeObserver = null;
  }

  onMounted(() => {
    // the mini player stays mounted for the whole session; with nothing loaded it has no blobs and no business
    // spending a frame callback. `post`: the blobs only exist in the DOM once the track has rendered.
    watch(() => !!currentTrack.value, (hasTrack) => { if (hasTrack) startLoop(); else stopLoop(); }, { immediate: true, flush: "post" });
  });

  onUnmounted(() => {
    stopLoop();
    resizeObserver?.disconnect();
  });

  return { bgColors, textColor, scrimColor, inverseTextColor, surfaceVars, setBlobRef };
}
