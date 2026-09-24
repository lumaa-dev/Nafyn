import { syncPlaybackSettings } from "~/composables/usePlaybackSettings";

export default defineNuxtPlugin(() => {
    void syncPlaybackSettings();
});
