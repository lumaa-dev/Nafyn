import { useAuthToken } from "~/composables/useAuthToken";

// The 30-second iTunes preview of a track the viewer does not own (GET /api/v1/track/{tid}/preview), on the
// catalog track and album pages. One preview at a time, on its own <audio> - never the player's: a preview is not
// a listen (no play tracking, no queue, no Nafyn Unity) - and the player is paused while one plays.
//
// Module-level on purpose (client only): every page shares the one element.

const playingId = ref<string | null>(null);
const loadingId = ref<string | null>(null);
const failedIds = ref(new Set<string>());
let audio: HTMLAudioElement | null = null;

function element(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = "none";
  audio.addEventListener("ended", () => { playingId.value = null; });
  audio.addEventListener("pause", () => { playingId.value = null; });
  return audio;
}

export function usePreview() {
  const { token } = useAuthToken();
  const player = useUnity();

  function stopPreview() {
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
    playingId.value = null;
    loadingId.value = null;
  }

  /** plays the preview of recording `tid`, or stops it when it is the one playing; false when there is none */
  async function togglePreview(tid: string): Promise<boolean> {
    if (import.meta.server || !token.value) return false;
    if (playingId.value === tid || loadingId.value === tid) {
      stopPreview();
      return true;
    }

    const el = element();
    el.pause();
    if (player.state.value.isPlaying) player.togglePlay();

    loadingId.value = tid;
    el.src = `/api/v1/track/${tid}/preview?token=${encodeURIComponent(token.value)}`;
    try {
      await el.play();
      if (loadingId.value !== tid) return true;
      playingId.value = tid;
      return true;
    } catch {
      if (loadingId.value === tid) {
        failedIds.value = new Set([...failedIds.value, tid]);
      }
      return false;
    } finally {
      if (loadingId.value === tid) loadingId.value = null;
    }
  }

  // the player starting (here or from another device through Unity) ends the preview
  watch(() => player.state.value.isPlaying, (isPlaying) => { if (isPlaying) stopPreview(); });

  // the page that started it is gone: so is the preview
  onBeforeUnmount(stopPreview);

  return { playingId, loadingId, failedIds, togglePreview, stopPreview };
}
