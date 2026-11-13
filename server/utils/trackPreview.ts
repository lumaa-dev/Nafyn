// 30-second previews of tracks the viewer does not own (catalog track / album pages), from the iTunes Search API.
// The audio is proxied (GET /api/v1/track/{tid}/preview/audio): the web app's CSP only plays media from itself, and
// AVPlayer / Safari need byte ranges, which this serves from a small in-memory cache (a preview is ~1 MB).

import type { IRecording, RecordingIncludes } from "musicbrainz-api";
import { getAppleMusicTrackID, getMusicBrainzRepository, TRACK_LOOKUP_INC } from "./musicbrainz";
import { pickCanonicalRelease } from "./release";
import { isAllowedPreviewHost, pickPreview, type ITunesSong, type PreviewTarget } from "./trackPreviewPick";

const ITUNES = "https://itunes.apple.com";
const FETCH_TIMEOUT_MS = 8_000;
const MAX_PREVIEW_BYTES = 5 * 1024 * 1024;

// recording MBID -> preview URL (null: none found), kept a day (an hour for "none")
const PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;
const NONE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHED_URLS = 2000;
const urlCache = new Map<string, { expires: number, url: string | null }>();

// recording MBID -> audio bytes, the 30 most recent
const MAX_CACHED_AUDIO = 30;
const audioCache = new Map<string, { bytes: Uint8Array, contentType: string }>();
const inFlight = new Map<string, Promise<string | null>>();

async function fetchJson<T>(url: string): Promise<T | null> {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), headers: { Accept: "application/json" } }).catch(() => null);
    if (!response?.ok) return null;
    return await response.json().catch(() => null) as T | null;
}

async function lookupById(id: string): Promise<ITunesSong[]> {
    const result = await fetchJson<{ results?: ITunesSong[] }>(`${ITUNES}/lookup?id=${encodeURIComponent(id)}&entity=song`);
    return result?.results ?? [];
}

async function searchSongs(term: string): Promise<ITunesSong[]> {
    const result = await fetchJson<{ results?: ITunesSong[] }>(`${ITUNES}/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=15`);
    return result?.results ?? [];
}

async function resolvePreviewUrl(recordingId: string): Promise<string | null> {
    const recording: IRecording = await getMusicBrainzRepository().lookup("recording", recordingId, TRACK_LOOKUP_INC as RecordingIncludes[]);
    const release = pickCanonicalRelease(recording.releases);
    const target: PreviewTarget = {
        title: recording.title,
        artist: (recording["artist-credit"] ?? []).map((credit) => `${credit.name}${credit.joinphrase ?? ""}`).join("").trim(),
        duration: recording.length ? Math.round(recording.length / 1000) : 0
    };

    // the Apple Music id MusicBrainz links to is the surest; it is still checked against the recording
    const amId = getAppleMusicTrackID(recording, release);
    if (amId) {
        const picked = pickPreview(await lookupById(amId), target);
        if (picked?.previewUrl) return picked.previewUrl;
    }
    const firstArtist = recording["artist-credit"]?.[0]?.name ?? target.artist;
    const picked = pickPreview(await searchSongs(`${firstArtist} ${target.title}`), target);
    return picked?.previewUrl ?? null;
}

/** The iTunes preview URL of a recording, null when iTunes has none for it. Throws when MusicBrainz does. */
export async function findPreviewUrl(recordingId: string): Promise<string | null> {
    const key = recordingId.toLowerCase();
    const cached = urlCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.url;

    const running = inFlight.get(key);
    if (running) return await running;

    const job = resolvePreviewUrl(key).then((url) => {
        urlCache.delete(key);
        urlCache.set(key, { expires: Date.now() + (url ? PREVIEW_TTL_MS : NONE_TTL_MS), url });
        while (urlCache.size > MAX_CACHED_URLS) {
            const oldest = urlCache.keys().next().value;
            if (oldest === undefined) break;
            urlCache.delete(oldest);
        }
        return url;
    }).finally(() => inFlight.delete(key));
    inFlight.set(key, job);
    return await job;
}

/** true when the preview's audio is already in memory (serving it costs no upstream call) */
export function hasCachedPreviewAudio(recordingId: string): boolean {
    return audioCache.has(recordingId.toLowerCase());
}

/** The preview's audio, fetched once (redirects checked against Apple's hosts) and kept for a while. */
export async function getPreviewAudio(recordingId: string): Promise<{ bytes: Uint8Array, contentType: string } | null> {
    const key = recordingId.toLowerCase();
    const cached = audioCache.get(key);
    if (cached) {
        audioCache.delete(key);
        audioCache.set(key, cached);
        return cached;
    }

    let url = await findPreviewUrl(key);
    if (!url) return null;

    for (let hop = 0; hop < 4; hop++) {
        if (!isAllowedPreviewHost(url)) return null;
        const response: Response | null = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).catch(() => null);
        if (!response) return null;
        if (response.status >= 300 && response.status < 400) {
            const location: string | null = response.headers.get("location");
            if (!location) return null;
            url = new URL(location, url).toString();
            continue;
        }
        if (!response.ok) return null;
        const length = Number(response.headers.get("content-length") ?? 0);
        if (length > MAX_PREVIEW_BYTES) return null;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength === 0 || bytes.byteLength > MAX_PREVIEW_BYTES) return null;

        const entry = { bytes, contentType: response.headers.get("content-type")?.split(";")[0]?.trim() || "audio/mp4" };
        audioCache.set(key, entry);
        while (audioCache.size > MAX_CACHED_AUDIO) {
            const oldest = audioCache.keys().next().value;
            if (oldest === undefined) break;
            audioCache.delete(oldest);
        }
        return entry;
    }
    return null;
}
