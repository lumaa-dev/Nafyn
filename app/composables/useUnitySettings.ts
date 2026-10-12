// per-user Nafyn Unity opt-out (Settings -> Sessions), read by useUnity.ts. Same shape as usePlaybackSettings:
// one reactive useState mirror, synced once by a client plugin.
export interface UnitySettings {
    enabled: boolean
}

const DEFAULT_SETTINGS: UnitySettings = { enabled: true };

export const useUnitySettings = () => useState<UnitySettings>("unity-settings", () => ({ ...DEFAULT_SETTINGS }));

function authToken(): string | null {
    return useAuthToken().token.value;
}

export async function syncUnitySettings(): Promise<void> {
    const token = authToken();
    if (!token) return;

    try {
        useUnitySettings().value = await $fetch<UnitySettings>("/api/v1/user/unity-settings", {
            headers: { Authorization: token }
        });
    } catch {
        // defaults stay in place
    }
}

export async function setUnitySetting(changes: Partial<UnitySettings>): Promise<void> {
    const token = authToken();
    if (!token) return;

    const state = useUnitySettings();
    const previous = { ...state.value };
    state.value = { ...state.value, ...changes };

    try {
        state.value = await $fetch<UnitySettings>("/api/v1/user/unity-settings", {
            method: "PATCH",
            headers: { Authorization: token },
            body: changes
        });
    } catch {
        state.value = previous;
        throw new Error("Couldn't save Unity settings");
    }
}

// a per-device, non-persisted override: "turn off Unity on this device only, for this session". Deliberately
// sessionStorage, not account-wide settings - it must never sync anywhere or survive a tab close. Exposed as
// a reactive useState (read once from sessionStorage, mirrored there on change) so useUnity.ts's connection
// watcher reacts to it the same way it reacts to the account-wide setting.
const SESSION_OVERRIDE_KEY = "nafyn-unity-disabled-this-session";

function readSessionOverride(): boolean {
    if (!import.meta.client) return false;
    try {
        return sessionStorage.getItem(SESSION_OVERRIDE_KEY) === "1";
    } catch {
        return false;
    }
}

export const useUnitySessionOverride = () => useState<boolean>("unity-session-override", readSessionOverride);

export function setUnityDisabledThisSession(disabled: boolean): void {
    useUnitySessionOverride().value = disabled;

    if (!import.meta.client) return;
    try {
        if (disabled) sessionStorage.setItem(SESSION_OVERRIDE_KEY, "1");
        else sessionStorage.removeItem(SESSION_OVERRIDE_KEY);
    } catch {
        // private browsing/blocked storage - the override simply can't persist even within the tab
    }
}
