// per-user playback preferences (Settings -> Playback), read by usePlayer's crossfade. Same shape as
// useAppearanceSettings: one reactive useState mirror, synced once by a client plugin.
export interface PlaybackSettings {
    crossfadeEnabled: boolean,
    crossfadeMs: number
}

const DEFAULT_SETTINGS: PlaybackSettings = { crossfadeEnabled: true, crossfadeMs: 3000 };

export const usePlaybackSettings = () => useState<PlaybackSettings>("playback-settings", () => ({ ...DEFAULT_SETTINGS }));

function authToken(): string | null {
    return useCookie("nafynToken").value ?? null;
}

export async function syncPlaybackSettings(): Promise<void> {
    const token = authToken();
    if (!token) return;

    try {
        usePlaybackSettings().value = await $fetch<PlaybackSettings>("/api/v1/user/playback-settings", {
            headers: { Authorization: token }
        });
    } catch {
        // defaults stay in place
    }
}

export async function setPlaybackSetting(changes: Partial<PlaybackSettings>): Promise<void> {
    const token = authToken();
    if (!token) return;

    const state = usePlaybackSettings();
    const previous = { ...state.value };
    state.value = { ...state.value, ...changes };

    try {
        state.value = await $fetch<PlaybackSettings>("/api/v1/user/playback-settings", {
            method: "PATCH",
            headers: { Authorization: token },
            body: changes
        });
    } catch {
        state.value = previous;
        throw new Error("Couldn't save playback settings");
    }
}
