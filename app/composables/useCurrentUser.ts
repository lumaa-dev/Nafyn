import type { NafynUser } from "~~/server/entity/NafynUser";
import { hasPermission, type Permission } from "~~/server/entity/Permission";
import { useAuthToken } from "~/composables/useAuthToken";

/**
 * The signed-in account, fetched once and shared. Components that only need to know what the person may do
 * (show the accept/deny buttons, ...) read `can()` instead of each fetching /user/me themselves.
 * The server re-checks every permission on every request; this only decides what to show.
 */
export function useCurrentUser() {
  const { token } = useAuthToken();
  const user = useState<NafynUser | null>("current-user", () => null);

  const permissions = computed(() => typeof user.value?.permissions === "number" ? user.value.permissions : 0);

  /** loads the account if it isn't loaded yet; resolves (never throws) so callers can simply await it */
  async function ensureLoaded(): Promise<void> {
    if (user.value || !token.value) return;
    try {
      user.value = await $fetch<NafynUser>("/api/v1/user/me", { headers: { Authorization: token.value } });
    } catch {
      // the layout already redirects an unauthenticated visit; a failure here only means no extra buttons
    }
  }

  return {
    user,
    permissions,
    ensureLoaded,
    can: (permission: Permission) => hasPermission(permissions.value, permission)
  };
}
