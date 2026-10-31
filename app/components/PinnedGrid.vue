<template>
  <section v-if="visible.length > 0" class="pinned" :aria-label="$t('pins.title')">
    <h2 class="pinned-title">{{ $t('pins.title') }}</h2>
    <ul class="pinned-grid">
      <li v-for="pin in visible" :key="`${pin.kind}-${pin.refId}`">
        <NuxtLink :to="pin.href" class="pin-card" @contextmenu.prevent="onMenu($event, pin)">
          <CoverImage :src="pinCover(pin)" />
          <span class="pin-text">
            <span class="pin-name">{{ pin.title }}</span>
            <span class="pin-sub">{{ pin.subtitle ? `${$t(`pins.kind.${pin.kind}`)} · ${pin.subtitle}` : $t(`pins.kind.${pin.kind}`) }}</span>
          </span>
        </NuxtLink>
      </li>
    </ul>
  </section>
</template>

<script lang="ts" setup>
// The pinned albums, playlists and tracks, three to a row. Right-click opens the same menu as everywhere else
// (so a pin can be unpinned from here).
import noCover from '~/assets/no-cover.png';
import type { AlbumRow } from '~~/server/core/library';
import { useAuthToken } from '~/composables/useAuthToken';
import type { PinEntry, PinKind } from '~/composables/usePins';

const props = defineProps<{ kinds?: PinKind[] }>();

const { token } = useAuthToken();
const { pins, ensureLoaded, refresh: refreshPins } = usePins();
const { openMenu } = useMediaMenu();

await ensureLoaded();

const visible = computed(() => props.kinds ? pins.value.filter((pin) => props.kinds!.includes(pin.kind)) : pins.value);

function pinCover(pin: PinEntry): string {
  if (pin.kind === "playlist") {
    return pin.playlistImage ? `/api/v1/playlist/${pin.refId}/image?token=${encodeURIComponent(token.value ?? "")}&v=${pin.playlistImage}` : noCover;
  }
  return coverSrc(pin.media ?? { coverArt: pin.coverArt, coverMediaId: pin.coverMediaId });
}

function onMenu(event: MouseEvent, pin: PinEntry) {
  if (pin.kind === "track" && pin.media) {
    void openMenu(event, { kind: "track", media: pin.media }, { onChanged: () => void refreshPins() });
  } else if (pin.kind === "album") {
    // the menu needs the album's id and title; the rest of an AlbumRow is never read from a pin
    const album = { id: pin.refId, title: pin.title, artistName: pin.subtitle ?? "", coverArt: pin.coverArt, coverMediaId: pin.coverMediaId } as AlbumRow;
    void openMenu(event, { kind: "album", album }, { onChanged: () => void refreshPins() });
  } else if (pin.kind === "playlist") {
    void openMenu(event, { kind: "playlist", playlist: { id: pin.refId, title: pin.title }, isOwner: pin.isOwner, isMember: pin.isMember }, { onChanged: () => void refreshPins() });
  }
}
</script>

<style>
.pinned {
  margin: 0 0 1.4em;
}

.pinned-title {
  font-size: 1em;
  margin-bottom: 0.5em;
}

.pinned-grid {
  list-style: none;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
}

.pin-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 12px 8px 8px;
  border-radius: 10px;
  background: #00000040;
  color: #ffffff;
  text-decoration: none;
  font-family: "Instrument-Serif";
  min-width: 0;
  transition: background 0.15s ease-out;
}

.pin-card:hover {
  background: #ffffff1a;
}

.pin-card img {
  width: 52px;
  height: 52px;
  flex-shrink: 0;
  border-radius: 6px;
  object-fit: cover;
  background: #00000040;
}

.pin-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.pin-name {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pin-sub {
  font-size: 0.75em;
  color: #ffffff;
  opacity: 0.85;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media screen and (max-width: 520px) {
  .pinned-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
