import type { Ref } from "vue";

/**
 * Reports a failed page load (`error` from useAsyncData/useFetch) as a toast.
 *
 * Without this a page whose data failed to load just renders nothing: its `v-if="album"` is false and the
 * person is left looking at an empty screen with no idea why. Fires on the client only - a toast raised during
 * SSR would be serialised into the page state without its dismiss timer and then never go away - which is why
 * an error that happened server-side is reported from `onMounted` rather than where it occurred.
 */
export function useLoadErrorToast(error: Ref<unknown>, title: string | null = null) {
  const report = (e: unknown) => {
    if (!e) return;
    // the "no token" rejection pages use to short-circuit: app.vue is already sending that person to /login
    if (e instanceof Error && e.message === "Not authenticated") return;
    useToast().sendError(title, e);
  };

  onMounted(() => {
    report(error.value);
    watch(error, report);
  });
}
