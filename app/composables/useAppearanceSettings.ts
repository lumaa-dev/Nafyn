// per-user display preferences (Settings -> Appearance): show/hide file size and duration in track lists.
//
// Loaded once at app start (see app/plugins/appearanceSettings.client.ts), same shape as
// usePlayTracking's history opt-in - a reactive useState mirror that every track-list page reads, kept in
// sync by a single client plugin rather than each page re-fetching it.
export interface AppearanceSettings {
    showFileSize: boolean,
    showDuration: boolean
}

const DEFAULT_SETTINGS: AppearanceSettings = { showFileSize: true, showDuration: true };

export const useAppearanceSettings = () => useState<AppearanceSettings>("appearance-settings", () => ({ ...DEFAULT_SETTINGS }));

function authToken(): string | null {
    return useCookie("nafynToken").value ?? null;
}

export async function syncAppearanceSettings(): Promise<void> {
    const token = authToken();
    if (!token) return;

    try {
        const settings = await $fetch<AppearanceSettings>("/api/v1/user/appearance-settings", {
            headers: { Authorization: token }
        });
        useAppearanceSettings().value = settings;
    } catch {
        // leave the defaults in place - whichever screen needed this re-syncs on its own next visit
    }
}

export async function setAppearanceSetting(changes: Partial<AppearanceSettings>): Promise<void> {
    const token = authToken();
    if (!token) return;

    const state = useAppearanceSettings();
    const previous = { ...state.value };
    state.value = { ...state.value, ...changes };

    try {
        state.value = await $fetch<AppearanceSettings>("/api/v1/user/appearance-settings", {
            method: "PATCH",
            headers: { Authorization: token },
            body: changes
        });
    } catch {
        // roll back to what the server actually has, not the optimistic guess
        state.value = previous;
        throw new Error("Couldn't save appearance settings");
    }
}
