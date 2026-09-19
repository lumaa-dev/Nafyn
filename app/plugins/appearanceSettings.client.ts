// Loads the user's Appearance preferences (file size / duration visibility) once, at app start - same
// reasoning as insights.client.ts: every track-list page reads this, so it belongs in a client plugin, not
// in each page individually.
import { syncAppearanceSettings } from "~/composables/useAppearanceSettings";

export default defineNuxtPlugin(() => {
    void syncAppearanceSettings();
});
