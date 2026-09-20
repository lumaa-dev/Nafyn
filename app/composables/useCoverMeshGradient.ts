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
  const { state, currentTrack } = usePlayer();

  const trackColors = ref<TrackColors>({ imageColors: [], textColor: DEFAULT_TEXT });

  async function loadColorsFor(mediaId: string) {
    const cached = colorCache.get(mediaId);
    if (cached) {
      trackColors.value = cached;
      return;
    }

    try {
      const token = useCookie("nafynToken").value ?? "";
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
  // a fixed-contrast tint painted over the blobs (below the text) so legibility never depends on how
  // saturated/light the cover's dominant colors happen to be - the blobs stay visible through it, but
  // muted/gray text always sits on a controlled, consistent backdrop
  const scrimColor = computed(() => textColor.value === "#000000" ? "rgba(255, 255, 255, 0.55)" : "rgba(0, 0, 0, 0.6)");
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

  function placeBlobsStatically() {
    for (let i = 0; i < BLOB_COUNT; i++) {
      const el = blobEls[i];
      const motion = BLOB_MOTION[i];
      if (!el || !motion) continue;
      el.style.left = `${motion.cx}%`;
      el.style.top = `${motion.cy}%`;
      el.style.transform = "translate(-50%, -50%)";
      el.style.opacity = "0.8";
    }
  }

  function tick(timestampMs: number) {
    rafId = requestAnimationFrame(tick);

    const t = timestampMs / 1000;
    const targetBass = state.value.isPlaying ? getBassLevel() : 0;
    // slow attack/release so the pulse reads as "breathing with the music" rather than flickering per-frame
    smoothedBass += (targetBass - smoothedBass) * 0.1;

    for (let i = 0; i < BLOB_COUNT; i++) {
      const el = blobEls[i];
      const motion = BLOB_MOTION[i];
      if (!el || !motion) continue;

      const angle = t * motion.speed + motion.phase;
      const x = motion.cx + motion.ampX * Math.sin(angle);
      const y = motion.cy + motion.ampY * Math.cos(angle * 0.85 + motion.phase);
      const scale = 1 + smoothedBass * 0.22;
      const opacity = 0.8 + smoothedBass * 0.2;

      el.style.left = `${x}%`;
      el.style.top = `${y}%`;
      el.style.transform = `translate(-50%, -50%) scale(${scale})`;
      el.style.opacity = `${opacity}`;
    }
  }

  onMounted(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      placeBlobsStatically();
      return;
    }
    rafId = requestAnimationFrame(tick);
  });

  onUnmounted(() => {
    if (rafId !== null) cancelAnimationFrame(rafId);
  });

  return { bgColors, textColor, scrimColor, setBlobRef };
}
