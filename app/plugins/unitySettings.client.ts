import { syncUnitySettings } from "~/composables/useUnitySettings";

export default defineNuxtPlugin(() => {
    void syncUnitySettings();
});
