// The one place that decides what a context menu contains - for a track, an album, a playlist, or several of
// them at once (bulk select). Every page asks this composable for its menu instead of building its own, so the
// same element offers the same actions wherever it is shown. The menu itself, the playlist picker and the
// metadata editor are rendered once by <MediaMenuHost> (mounted in app.vue); this file owns the state they read.
//
// A page only says WHAT was clicked (`openMenu(event, { kind: "track", media })`) and, through `options`, what
// is special about where it sits (a track inside a playlist can be removed from that playlist; a track in the
// "everyone's library" view can be removed from each owner's library). `options.onChanged` tells the page what
// happened so it can patch its list.
import type { MediaRow, AlbumRow } from "~~/server/core/library";
import type { ContextMenuItem } from "~/components/ContextMenu.vue";
import { useAuthToken } from "~/composables/useAuthToken";
import type { PinKind } from "~/composables/usePins";
import { EXTERNAL_SERVICES, EXTERNAL_SERVICE_NAMES, externalQuery, externalSearchUrl } from "~/utils/externalLinks";

export interface TrackSubject {
  kind: "track",
  media: MediaRow,
  /** false when the track is not in the viewer's library (a shared playlist's track): no details / pin / delete */
  owned?: boolean,
  /** can be edited although not owned (a music manager); defaults to `owned` */
  canEdit?: boolean
}
export interface AlbumSubject { kind: "album", album: AlbumRow }
export interface PlaylistSubject { kind: "playlist", playlist: { id: string, title: string }, isOwner?: boolean, isMember?: boolean }
export type MenuSubject = TrackSubject | AlbumSubject | PlaylistSubject;

export interface MenuChange {
  type: "deleted" | "removed" | "edited" | "pinned" | "left",
  /** media ids (tracks), album ids, or playlist ids, depending on the subject */
  ids: string[],
  /** the rewritten rows, for "edited" */
  media?: MediaRow[]
}

export interface MenuOptions {
  onChanged?: (change: MenuChange) => void,
  /** the track sits in this playlist entry: offer "Remove from playlist" when the viewer may */
  playlistEntry?: { playlistId: string, entryId: string, canRemove: boolean },
  /** bulk: the selected tracks' entries in the playlist being viewed */
  playlistEntries?: { playlistId: string, entries: { mediaId: string, entryId: string, canRemove: boolean }[] },
  /** the accounts that hold the track ("everyone's library"): "Remove from <user>'s library" for each */
  owners?: { userId: string, username: string }[],
  /** the playlist picker lists every playlist on the instance (admin view) rather than the viewer's own */
  pickerAdmin?: boolean,
  /** the menu is already on the details page of the element */
  hideDetails?: boolean
}

interface HostState {
  items: ContextMenuItem[],
  anchor: { x: number, y: number, seq: number },
  picker: { open: boolean, mediaIds: string[], admin: boolean },
  edit: { open: boolean, targets: MediaRow[] },
  onEdited: ((rows: MediaRow[]) => void) | null,
  changeAlbum: { open: boolean, media: MediaRow | null },
  onAlbumChanged: ((row: MediaRow) => void) | null
}

// client-only and module-level on purpose: closures don't belong in useState (it is serialised into the page)
const host = reactive<HostState>({
  items: [],
  anchor: { x: 0, y: 0, seq: 0 },
  picker: { open: false, mediaIds: [], admin: false },
  edit: { open: false, targets: [] },
  onEdited: null,
  changeAlbum: { open: false, media: null },
  onAlbumChanged: null
});

export function useMediaMenuHost() {
  return host;
}

/** where a menu goes: at the cursor for a right click, under the element for a click on its "..." button */
export function menuAnchor(e: Event | { x: number, y: number }): { x: number, y: number } {
  if (!(e instanceof Event)) return e;
  const el = e.currentTarget as HTMLElement | null;
  if (e.type === "contextmenu" || !el) {
    const mouse = e as MouseEvent;
    return { x: mouse.clientX, y: mouse.clientY };
  }
  const rect = el.getBoundingClientRect();
  return { x: rect.left, y: rect.bottom };
}

// how many album / playlist fetches run at once when a bulk action has to look inside many of them
const EXPAND_CONCURRENCY = 4;

export function useMediaMenu() {
  const { token } = useAuthToken();
  const { currentTrack, play, addToQueue } = useUnity();
  const pins = usePins();
  const { sendError, sendToast } = useToast();
  // `$t` is only a global inside .vue files - a composable takes the translator from i18n at setup
  const { t } = useI18n();

  const auth = () => ({ Authorization: token.value ?? "" });

  function open(anchor: { x: number, y: number }, items: ContextMenuItem[]) {
    host.items = items;
    host.anchor = { x: anchor.x, y: anchor.y, seq: host.anchor.seq + 1 };
  }

  // ---- what a subject expands to ---------------------------------------------------------------------------

  async function albumTracks(albumId: string): Promise<MediaRow[]> {
    const detail = await $fetch<{ tracks: MediaRow[] }>(`/api/v1/library/album/${albumId}`, { headers: auth() });
    return detail.tracks;
  }

  async function playlistTracks(playlistId: string): Promise<MediaRow[]> {
    const tracks: MediaRow[] = [];
    for (let page = 1; page <= 50; page++) {
      const result = await $fetch<{ items: { media: MediaRow }[], hasMore: boolean }>(`/api/v1/playlist/${playlistId}/tracks`, {
        headers: auth(),
        query: { page, limit: 200 }
      });
      tracks.push(...result.items.map((entry) => entry.media));
      if (!result.hasMore) break;
    }
    return tracks;
  }

  async function mapLimited<T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(EXPAND_CONCURRENCY, items.length) }, async () => {
      while (next < items.length) {
        const at = next++;
        results[at] = await fn(items[at]!);
      }
    }));
    return results;
  }

  /** every track behind the subjects, in order, without duplicates */
  async function expand(subjects: MenuSubject[]): Promise<MediaRow[]> {
    const lists = await mapLimited(subjects, async (subject) => {
      if (subject.kind === "track") return [subject.media];
      if (subject.kind === "album") return await albumTracks(subject.album.id);
      return await playlistTracks(subject.playlist.id);
    });

    const seen = new Set<string>();
    return lists.flat().filter((track) => !seen.has(track.id) && !!seen.add(track.id));
  }

  // ---- actions -----------------------------------------------------------------------------------------------

  function guarded(title: string | null, fallback: string, fn: () => Promise<void>) {
    return async () => {
      try {
        await fn();
      } catch (e) {
        sendError(title, e, fallback);
      }
    };
  }

  async function queueMany(tracks: MediaRow[], position: "next" | "end") {
    if (tracks.length === 0) return;
    // nothing playing: the first track starts, the rest line up behind it
    if (!currentTrack.value) {
      await play(tracks[0]!, tracks);
      return;
    }
    // "next" inserts right after the current track, so inserting in order would reverse them
    for (const track of position === "next" ? [...tracks].reverse() : tracks) await addToQueue(track, position);
  }

  async function playMany(tracks: MediaRow[], context?: { type: "album" | "playlist", refId: string }) {
    if (tracks.length === 0) return;
    await play(tracks[0]!, tracks, context);
  }

  function openPicker(mediaIds: string[], admin = false) {
    host.picker = { open: true, mediaIds, admin };
  }

  function openEdit(targets: MediaRow[], onChanged?: MenuOptions["onChanged"]) {
    host.onEdited = (rows) => onChanged?.({ type: "edited", ids: rows.map((row) => row.id), media: rows });
    host.edit = { open: true, targets };
  }

  function openChangeAlbum(media: MediaRow, onChanged?: MenuOptions["onChanged"]) {
    // the track now sits on another album: to a list that is an edit (new album, cover, date, position)
    host.onAlbumChanged = (row) => onChanged?.({ type: "edited", ids: [row.id], media: [row] });
    host.changeAlbum = { open: true, media };
  }

  async function togglePin(kind: PinKind, refId: string, onChanged?: MenuOptions["onChanged"]) {
    const nowPinned = await pins.toggle(kind, refId);
    sendToast({ title: null, content: nowPinned ? t("menu.pinned") : t("menu.unpinned"), icon: null, tint: "green" });
    onChanged?.({ type: "pinned", ids: [refId] });
  }

  async function togglePinMany(items: { kind: PinKind, refId: string }[], onChanged?: MenuOptions["onChanged"]) {
    const nowPinned = await pins.toggleMany(items);
    sendToast({ title: null, content: nowPinned ? t("menu.pinned") : t("menu.unpinned"), icon: null, tint: "green" });
    onChanged?.({ type: "pinned", ids: items.map((item) => item.refId) });
  }

  // deletes sequentially and reports what actually went: a failure on one must not stop the rest, nor hide
  // that the others went through
  async function deleteTracks(tracks: MediaRow[]): Promise<string[]> {
    const deleted: string[] = [];
    for (const track of tracks) {
      try {
        await $fetch(`/api/v1/library/${track.id}`, { method: "DELETE", headers: auth() });
        deleted.push(track.id);
      } catch (e) {
        sendError(track.title, e, t("track.deleteError"));
      }
    }
    if (deleted.length > 0) await pins.refresh();
    return deleted;
  }

  const confirmed = (message: string) => !import.meta.client || window.confirm(message);

  // ---- menus -----------------------------------------------------------------------------------------------

  // DESIGN.md sorts every menu into categories, most used first, with a divider and no header between them:
  // 1 playback, 2 "view" and playlists, 3 modifications, 4 destructive. Each builder fills its own four lists and
  // this joins the ones that are not empty, so a menu never starts, ends or doubles up on a divider.
  function categories(...groups: ContextMenuItem[][]): ContextMenuItem[] {
    return groups
      .filter((group) => group.length > 0)
      .flatMap((group, i) => i === 0 ? group : [{ label: "", separator: true }, ...group]);
  }

  // "Open on YouTube" and "Share" > one search link per service (DESIGN.md "Sharing": on the web, sharing copies the
  // link). A search for "artist title" on the other service - one item at a time, never in a bulk menu.
  function externalItems(title: string, artist: string | null): ContextMenuItem[] {
    const query = externalQuery(title, artist);
    if (!query) return [];
    return [
      { label: t("menu.openOnYouTube"), action: () => { window.open(externalSearchUrl("youtube", query), "_blank", "noopener,noreferrer"); } },
      {
        label: t("menu.share"),
        children: EXTERNAL_SERVICES.map((service) => ({
          label: EXTERNAL_SERVICE_NAMES[service],
          action: guarded(title, t("menu.shareError"), async () => {
            await navigator.clipboard.writeText(externalSearchUrl(service, query));
            sendToast({ title, content: t("menu.linkCopied", { service: EXTERNAL_SERVICE_NAMES[service] }), tint: "green", icon: null });
          })
        }))
      }
    ];
  }

  function trackItems(subject: TrackSubject, options: MenuOptions): ContextMenuItem[] {
    const { media } = subject;
    const owned = subject.owned !== false;

    const playback: ContextMenuItem[] = [
      { label: t("player.playNext"), action: () => void addToQueue(media, "next") },
      { label: t("player.addToQueue"), action: () => void addToQueue(media, "end") }
    ];

    const view: ContextMenuItem[] = [];
    if (!options.hideDetails && owned) {
      view.push({ label: t("track.viewDetails"), action: () => void navigateTo(`/l/t/${media.id}`) });
    }
    // a track the viewer does not own (a shared playlist's) cannot be added to a playlist: it is not in their library
    if (owned) {
      view.push({ label: t("playlist.addToPlaylist"), action: () => openPicker([media.id], options.pickerAdmin) });
      view.push({
        label: pins.isPinned("track", media.id) ? t("menu.unpin") : t("menu.pin"),
        action: guarded(media.title, t("menu.pinError"), () => togglePin("track", media.id, options.onChanged))
      });
    }
    view.push(...externalItems(media.title, media.artistName));

    const modify: ContextMenuItem[] = [];
    if (subject.canEdit ?? owned) {
      modify.push({ label: t("edit.title"), action: () => openEdit([media], options.onChanged) });
      modify.push({ label: t("album.change.menu"), action: () => openChangeAlbum(media, options.onChanged) });
    }

    const destructive: ContextMenuItem[] = [];
    const entry = options.playlistEntry;
    if (entry?.canRemove) {
      destructive.push({
        label: t("playlist.removeTrack"),
        danger: true,
        action: guarded(media.title, t("playlist.picker.error"), async () => {
          await $fetch(`/api/v1/playlist/${entry.playlistId}/tracks/${entry.entryId}`, { method: "DELETE", headers: auth() });
          options.onChanged?.({ type: "removed", ids: [media.id] });
        })
      });
    }

    if (options.owners) {
      // the admin view: the track is removed from one named account's library at a time
      for (const owner of options.owners) {
        destructive.push({
          label: t("library.all.removeFrom", { username: owner.username }),
          danger: true,
          action: guarded(media.title, t("track.deleteError"), async () => {
            await $fetch(`/api/v1/library/${media.id}/${owner.userId}`, { method: "DELETE", headers: auth() });
            options.onChanged?.({ type: "deleted", ids: [media.id] });
          })
        });
      }
    } else if (owned) {
      destructive.push({
        label: t("track.delete"),
        danger: true,
        action: async () => {
          const deleted = await deleteTracks([media]);
          if (deleted.length > 0) options.onChanged?.({ type: "deleted", ids: deleted });
        }
      });
    }

    return categories(playback, view, modify, destructive);
  }

  function albumItems(subject: AlbumSubject, options: MenuOptions): ContextMenuItem[] {
    const { album } = subject;
    const withTracks = (fn: (tracks: MediaRow[]) => void | Promise<void>) =>
      guarded(album.title, t("common.error"), async () => fn(await albumTracks(album.id)));

    const playback: ContextMenuItem[] = [
      { label: t("playlist.play"), action: withTracks((tracks) => playMany(tracks, { type: "album", refId: album.id })) },
      { label: t("player.playNext"), action: withTracks((tracks) => queueMany(tracks, "next")) },
      { label: t("player.addToQueue"), action: withTracks((tracks) => queueMany(tracks, "end")) }
    ];

    const view: ContextMenuItem[] = [];
    if (!options.hideDetails) {
      view.push({ label: t("menu.viewAlbum"), action: () => void navigateTo(`/l/a/${album.id}`) });
    }
    view.push(
      { label: t("playlist.addToPlaylist"), action: withTracks((tracks) => openPicker(tracks.map((track) => track.id), options.pickerAdmin)) },
      {
        label: pins.isPinned("album", album.id) ? t("menu.unpin") : t("menu.pin"),
        action: guarded(album.title, t("menu.pinError"), () => togglePin("album", album.id, options.onChanged))
      },
      ...externalItems(album.title, album.artistName)
    );

    const modify: ContextMenuItem[] = [
      { label: t("edit.title"), action: withTracks((tracks) => openEdit(tracks, options.onChanged)) }
    ];

    const destructive: ContextMenuItem[] = [
      {
        label: t("menu.deleteAlbum"),
        danger: true,
        action: guarded(album.title, t("track.deleteError"), async () => {
          const tracks = await albumTracks(album.id);
          if (!confirmed(t("menu.confirmDeleteAlbums", { count: 1, tracks: tracks.length }))) return;
          const deleted = await deleteTracks(tracks);
          if (deleted.length === tracks.length) options.onChanged?.({ type: "deleted", ids: [album.id] });
        })
      }
    ];

    return categories(playback, view, modify, destructive);
  }

  function playlistItems(subject: PlaylistSubject, options: MenuOptions): ContextMenuItem[] {
    const { playlist } = subject;
    const withTracks = (fn: (tracks: MediaRow[]) => void | Promise<void>) =>
      guarded(playlist.title, t("common.error"), async () => fn(await playlistTracks(playlist.id)));

    const playback: ContextMenuItem[] = [
      { label: t("playlist.play"), action: withTracks((tracks) => playMany(tracks, { type: "playlist", refId: playlist.id })) },
      { label: t("player.playNext"), action: withTracks((tracks) => queueMany(tracks, "next")) },
      { label: t("player.addToQueue"), action: withTracks((tracks) => queueMany(tracks, "end")) }
    ];

    const view: ContextMenuItem[] = [];
    if (!options.hideDetails) {
      view.push({ label: t("menu.viewPlaylist"), action: () => void navigateTo(`/l/playlist/${playlist.id}`) });
    }
    view.push({
      label: pins.isPinned("playlist", playlist.id) ? t("menu.unpin") : t("menu.pin"),
      action: guarded(playlist.title, t("menu.pinError"), () => togglePin("playlist", playlist.id, options.onChanged))
    });

    const destructive: ContextMenuItem[] = [];
    if (subject.isOwner) {
      destructive.push({
        label: t("playlist.delete.open"),
        danger: true,
        action: guarded(playlist.title, t("common.error"), async () => {
          if (!confirmed(t("menu.confirmDeletePlaylists", { count: 1 }))) return;
          await $fetch(`/api/v1/playlist/${playlist.id}`, { method: "DELETE", headers: auth() });
          await pins.refresh();
          options.onChanged?.({ type: "deleted", ids: [playlist.id] });
        })
      });
    } else if (subject.isMember) {
      destructive.push({
        label: t("playlist.leave"),
        danger: true,
        action: guarded(playlist.title, t("common.error"), async () => {
          await $fetch(`/api/v1/playlist/${playlist.id}/leave`, { method: "POST", headers: auth() });
          await pins.refresh();
          options.onChanged?.({ type: "left", ids: [playlist.id] });
        })
      });
    }

    return categories(playback, view, [], destructive);
  }

  // The menu appears at once. Whether something is pinned (Pin / Unpin) comes from a list that may not have
  // loaded yet or may fail to load: the menu never waits for it, and rebuilds its items when it arrives.
  function showWhenReady(anchor: { x: number, y: number }, build: () => ContextMenuItem[]) {
    open(anchor, build());
    if (!pins.loaded.value) {
      const shownSeq = host.anchor.seq;
      void pins.ensureLoaded().then(() => {
        // only if that menu is still the one on screen
        if (host.anchor.seq === shownSeq) host.items = build();
      });
    }
  }

  /** the menu of one element */
  async function openMenu(event: Event | { x: number, y: number }, subject: MenuSubject, options: MenuOptions = {}) {
    const anchor = menuAnchor(event);

    showWhenReady(anchor, () => subject.kind === "track"
      ? trackItems(subject, options)
      : subject.kind === "album"
        ? albumItems(subject, options)
        : playlistItems(subject, options));
  }

  /** the same actions for several elements of one kind at once */
  async function openBulkMenu(anchor: { x: number, y: number }, subjects: MenuSubject[], options: MenuOptions = {}) {
    if (subjects.length === 0) return;
    showWhenReady(anchor, () => bulkItems(subjects, options));
  }

  function bulkItems(subjects: MenuSubject[], options: MenuOptions): ContextMenuItem[] {
    const kind = subjects[0]!.kind;
    const count = subjects.length;
    // how many are selected: a title for the menu, not a category (those carry no header)
    const heading: ContextMenuItem[] = [{ label: t("bulk.count", { count }), disabled: true }];
    const playback: ContextMenuItem[] = [];
    const view: ContextMenuItem[] = [];
    const modify: ContextMenuItem[] = [];
    const destructive: ContextMenuItem[] = [];

    if (kind === "track") {
      const tracks = subjects as TrackSubject[];
      const owned = tracks.filter((subject) => subject.owned !== false).map((subject) => subject.media);
      const editable = tracks.filter((subject) => subject.canEdit ?? subject.owned !== false).map((subject) => subject.media);
      const all = tracks.map((subject) => subject.media);

      playback.push(
        { label: t("player.playNext"), action: () => void queueMany(all, "next") },
        { label: t("player.addToQueue"), action: () => void queueMany(all, "end") }
      );
      // only the owned ones can go into a playlist: the rest (a shared playlist's) are not in the viewer's library
      if (owned.length > 0) {
        view.push({ label: t("playlist.addToPlaylist"), action: () => openPicker(owned.map((media) => media.id), options.pickerAdmin) });
      }
      if (owned.length > 0) {
        const pinItems = owned.map((media) => ({ kind: "track" as const, refId: media.id }));
        view.push({
          label: pinItems.every((item) => pins.isPinned("track", item.refId)) ? t("menu.unpin") : t("menu.pin"),
          action: guarded(null, t("menu.pinError"), () => togglePinMany(pinItems, options.onChanged))
        });
      }
      if (editable.length > 0) {
        modify.push({ label: t("edit.title"), action: () => openEdit(editable, options.onChanged) });
      }

      const removable = options.playlistEntries?.entries.filter((entry) => entry.canRemove) ?? [];
      if (options.playlistEntries && removable.length > 0) {
        const { playlistId } = options.playlistEntries;
        destructive.push({
          label: t("playlist.removeTrack"),
          danger: true,
          action: guarded(null, t("playlist.picker.error"), async () => {
            const removed: string[] = [];
            for (const entry of removable) {
              await $fetch(`/api/v1/playlist/${playlistId}/tracks/${entry.entryId}`, { method: "DELETE", headers: auth() });
              removed.push(entry.mediaId);
            }
            options.onChanged?.({ type: "removed", ids: removed });
          })
        });
      }

      if (owned.length > 0 && !options.owners) {
        destructive.push({
          label: t("track.delete"),
          danger: true,
          action: async () => {
            if (!confirmed(t("menu.confirmDeleteTracks", { count: owned.length }))) return;
            const deleted = await deleteTracks(owned);
            if (deleted.length > 0) options.onChanged?.({ type: "deleted", ids: deleted });
          }
        });
      }
    } else if (kind === "album") {
      const albums = (subjects as AlbumSubject[]).map((subject) => subject.album);
      const withTracks = (fn: (tracks: MediaRow[]) => void | Promise<void>) =>
        guarded(null, t("common.error"), async () => fn(await expand(subjects)));
      const pinItems = albums.map((album) => ({ kind: "album" as const, refId: album.id }));

      playback.push(
        { label: t("player.playNext"), action: withTracks((tracks) => queueMany(tracks, "next")) },
        { label: t("player.addToQueue"), action: withTracks((tracks) => queueMany(tracks, "end")) }
      );
      view.push(
        { label: t("playlist.addToPlaylist"), action: withTracks((tracks) => openPicker(tracks.map((track) => track.id), options.pickerAdmin)) },
        {
          label: pinItems.every((item) => pins.isPinned("album", item.refId)) ? t("menu.unpin") : t("menu.pin"),
          action: guarded(null, t("menu.pinError"), () => togglePinMany(pinItems, options.onChanged))
        }
      );
      modify.push({ label: t("edit.title"), action: withTracks((tracks) => openEdit(tracks, options.onChanged)) });
      destructive.push({
        label: t("menu.deleteAlbum"),
        danger: true,
        action: guarded(null, t("track.deleteError"), async () => {
          const tracks = await expand(subjects);
          if (!confirmed(t("menu.confirmDeleteAlbums", { count: albums.length, tracks: tracks.length }))) return;
          const deleted = new Set(await deleteTracks(tracks));
          // an album is gone only when every one of its tracks is
          const gone = (await mapLimited(albums, async (album) => ({ album, tracks: await albumTracks(album.id).catch(() => [] as MediaRow[]) })))
            .filter((entry) => entry.tracks.length === 0 || entry.tracks.every((track) => deleted.has(track.id)))
            .map((entry) => entry.album.id);
          if (gone.length > 0) options.onChanged?.({ type: "deleted", ids: gone });
        })
      });
    } else {
      const playlists = subjects as PlaylistSubject[];
      const pinItems = playlists.map((subject) => ({ kind: "playlist" as const, refId: subject.playlist.id }));
      const withTracks = (fn: (tracks: MediaRow[]) => void | Promise<void>) =>
        guarded(null, t("common.error"), async () => fn(await expand(subjects)));

      playback.push(
        { label: t("player.playNext"), action: withTracks((tracks) => queueMany(tracks, "next")) },
        { label: t("player.addToQueue"), action: withTracks((tracks) => queueMany(tracks, "end")) }
      );
      view.push({
        label: pinItems.every((item) => pins.isPinned("playlist", item.refId)) ? t("menu.unpin") : t("menu.pin"),
        action: guarded(null, t("menu.pinError"), () => togglePinMany(pinItems, options.onChanged))
      });

      const owned = playlists.filter((subject) => subject.isOwner);
      if (owned.length > 0) {
        destructive.push({
          label: t("playlist.delete.open"),
          danger: true,
          action: guarded(null, t("common.error"), async () => {
            if (!confirmed(t("menu.confirmDeletePlaylists", { count: owned.length }))) return;
            const deleted: string[] = [];
            for (const subject of owned) {
              await $fetch(`/api/v1/playlist/${subject.playlist.id}`, { method: "DELETE", headers: auth() });
              deleted.push(subject.playlist.id);
            }
            await pins.refresh();
            options.onChanged?.({ type: "deleted", ids: deleted });
          })
        });
      }
    }

    return categories(heading, playback, view, modify, destructive);
  }

  return { openMenu, openBulkMenu };
}
