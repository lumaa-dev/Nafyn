import { useAuthToken } from "~/composables/useAuthToken";

// follow / unfollow an unreleased album or track (POST/DELETE /api/v1/subscriptions). The browser's own
// timezone goes with the subscription: the "out now" notification fires at local midnight there.
export function useReleaseSubscription() {
  const { token } = useAuthToken();
  const { t } = useI18n();
  const pending = ref(false);

  function toast(title: string | null, content: string, success: boolean) {
    useToast().sendToast({ title, content, tint: success ? "green" : "red", icon: null });
  }

  /** returns the new subscribed state (unchanged when the call failed) */
  async function toggle(musicbrainzId: string, type: "album" | "track", subscribed: boolean, title: string | null): Promise<boolean> {
    if (!token.value || pending.value) return subscribed;
    pending.value = true;

    try {
      if (subscribed) {
        await $fetch(`/api/v1/subscriptions/${musicbrainzId}`, {
          method: "DELETE",
          headers: { Authorization: token.value }
        });
        toast(title, t("upcoming.unsubscribed"), true);
        return false;
      }

      await $fetch("/api/v1/subscriptions", {
        method: "POST",
        headers: { Authorization: token.value },
        body: { id: musicbrainzId, type, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }
      });
      toast(title, t("upcoming.subscribed"), true);
      return true;
    } catch (e) {
      const message = (e as { data?: { statusMessage?: string } })?.data?.statusMessage ?? t("upcoming.error");
      toast(title, message, false);
      return subscribed;
    } finally {
      pending.value = false;
    }
  }

  return { toggle, pending };
}
