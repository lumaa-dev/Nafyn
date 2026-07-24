// registry for the right-side panels on the big "Now Playing" page (app/pages/now-playing.vue).
// to add a new panel: drop a component in app/components/panels/, then add one entry below.
import type { Component } from "vue";
import QueuePanel from "~/components/panels/QueuePanel.vue";

export interface NowPlayingPanel {
    id: string;
    // i18n key for the tab label, e.g. "player.queue" -> $t(panel.label)
    label: string;
    component: Component;
}

export const nowPlayingPanels: NowPlayingPanel[] = [
    { id: "queue", label: "player.queue", component: QueuePanel },
    { id: "lyrics", label: "player.lyrics", component: QueuePanel }
];
