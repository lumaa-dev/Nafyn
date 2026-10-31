// Pins (albums, playlists, tracks) of the signed-in account: the list shown as a grid on the Library home and at
// the top of Tracks, and the pin / unpin used by every context menu. One shared list; the server prunes pins
// whose target is gone when it serves it (server/core/pins.ts).
import type { PinEntry, PinKind } from "~~/server/core/pins";
import { useAuthToken } from "~/composables/useAuthToken";

export type { PinEntry, PinKind };

export function usePins() {
  const { token } = useAuthToken();
  const pins = useState<PinEntry[]>("pins", () => []);
  const loaded = useState<boolean>("pins-loaded", () => false);

  async function refresh(): Promise<void> {
    if (!token.value) return;
    try {
      pins.value = await $fetch<PinEntry[]>("/api/v1/pins", { headers: { Authorization: token.value } });
      loaded.value = true;
    } catch (e) {
      // the pins grid is decoration around the page's own content; a context menu that cannot tell whether
      // something is pinned just offers "Pin" - but a person who asked to see their pins is told
      if (import.meta.client) useToast().sendError(null, e);
    }
  }

  async function ensureLoaded(): Promise<void> {
    if (!loaded.value) await refresh();
  }

  function isPinned(kind: PinKind, refId: string): boolean {
    return pins.value.some((pin) => pin.kind === kind && pin.refId === refId);
  }

  async function pin(kind: PinKind, refId: string): Promise<void> {
    if (!token.value) return;
    await $fetch("/api/v1/pins", { method: "POST", headers: { Authorization: token.value }, body: { kind, refId } });
  }

  async function unpin(kind: PinKind, refId: string): Promise<void> {
    if (!token.value) return;
    await $fetch("/api/v1/pins", { method: "DELETE", headers: { Authorization: token.value }, query: { kind, refId } });
  }

  /** pins what isn't pinned, unpins what is; one reload at the end. Throws on failure (callers toast). */
  async function toggle(kind: PinKind, refId: string): Promise<boolean> {
    const wasPinned = isPinned(kind, refId);
    if (wasPinned) await unpin(kind, refId);
    else await pin(kind, refId);
    await refresh();
    return !wasPinned;
  }

  /** pins every item when any of them is not pinned yet, unpins them all when every one already is */
  async function toggleMany(items: { kind: PinKind, refId: string }[]): Promise<boolean> {
    const allPinned = items.every((item) => isPinned(item.kind, item.refId));
    for (const item of items) {
      if (allPinned) await unpin(item.kind, item.refId);
      else if (!isPinned(item.kind, item.refId)) await pin(item.kind, item.refId);
    }
    await refresh();
    return !allPinned;
  }

  return { pins, loaded, refresh, ensureLoaded, isPinned, pin, unpin, toggle, toggleMany };
}
