import { useAuthToken } from "~/composables/useAuthToken";

/**
 * Creates a download request (POST /api/v1/request) and reports the outcome as a toast.
 *
 * Returns true when a request exists afterwards - freshly created, or "you already requested this" (409) -
 * and false when it failed, which is the only case the caller should re-enable its Request button.
 * Callers disable the button *before* awaiting this, so a double click can't queue the same thing twice.
 */
export function useMediaRequest() {
  const { token } = useAuthToken();
  const { t } = useI18n();

  async function request(musicbrainzId: string, type: "album" | "track", toastTitle: string | null): Promise<boolean> {
    if (!token.value) return false;

    try {
      await $fetch("/api/v1/request", {
        method: "POST",
        headers: { Authorization: token.value },
        body: { id: musicbrainzId, type }
      });
      useToast().sendToast({ title: toastTitle, content: t(`${type}.requested`), tint: "green", icon: null });
      return true;
    } catch (e) {
      useToast().sendError(toastTitle, e, t('album.error'));
      return (e as { statusCode?: number })?.statusCode === 409;
    }
  }

  return { request };
}
