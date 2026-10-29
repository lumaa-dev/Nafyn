// Which MusicBrainz recording a track from another service is: by ISRC first, then by searching its title and
// artist. Shared by GET /api/v1/track/isrc/{isrc} and playlist imports (core/imports.ts).
import { getMusicBrainzRepository } from "../utils/musicbrainz";
import { MusicBrainzError } from "../utils/musicbrainzRepository";
import { getSearchDeps } from "../utils/catalogSearch";
import { searchTracks, type SearchDeps } from "../utils/search/engine";
import { acceptSearchResult, pickIsrcRecording, searchForms, type DescribedTrack, type IsrcRecording } from "../utils/trackPick";

const ISRC_PATTERN = /^[A-Z]{2}[A-Z0-9]{3}\d{2}\d{5}$/;

// a search result whose length agrees with the described one within 3 s is believed from this relevance on, below
// the search page's `bestResult` bar: the length is independent evidence the page doesn't have
const IMPORT_DURATION_MIN_SCORE = 0.7;
const SEARCH_RESULTS_CONSIDERED = 5;

export interface TrackDescription extends DescribedTrack {
    isrc?: string | null
}

export interface ResolvedTrack {
    recordingId: string,
    via: "isrc" | "search"
}

/**
 * The ISRC as MusicBrainz stores it, or null for anything that can't name a recording - including the `ZZ` country
 * prefix, which is never assigned (the iOS app sends `ZZZZZ0000000` for "no ISRC").
 */
export function usableIsrc(raw: string | null | undefined): string | null {
    const isrc = (raw ?? "").replace(/-/g, "").trim().toUpperCase();
    return ISRC_PATTERN.test(isrc) && !isrc.startsWith("ZZ") ? isrc : null;
}

let importDeps: SearchDeps | null = null;

// the search page's engine, minus its "Digital Media release only" filter: a track someone has in a streaming
// playlist exists digitally, whatever formats MusicBrainz happens to list. One stable object, the engine caches per config.
function getImportSearchDeps(): SearchDeps {
    if (!importDeps) {
        const base = getSearchDeps();
        importDeps = { ...base, config: { ...base.config, requireDigitalMedia: false } };
    }
    return importDeps;
}

/**
 * The recording `track` describes, or null when neither its ISRC nor a search for its title + artist finds one
 * convincingly. Throws `MusicBrainzError` when MusicBrainz can't be asked (busy, down): that is never "not found".
 */
export async function resolveDescribedTrack(track: TrackDescription): Promise<ResolvedTrack | null> {
    const isrc = usableIsrc(track.isrc);
    if (isrc) {
        try {
            // the ISRC resource, not an `isrc:` search: read from the database (no index lag) and it lists every
            // recording carrying the code, where a search with limit 1 handed back an arbitrary one of them
            const response = await getMusicBrainzRepository().request<{ recordings?: IsrcRecording[] }>(`/isrc/${isrc}`, { inc: "artist-credits" });
            const picked = pickIsrcRecording(response?.recordings ?? [], track);
            if (picked) return { recordingId: picked.id, via: "isrc" };
        } catch (error) {
            // 404/400: MusicBrainz doesn't know this code - search instead. Anything else is MusicBrainz being unavailable.
            if (!(error instanceof MusicBrainzError) || (error.status !== 404 && error.status !== 400)) throw error;
        }
    }

    if (!track.title?.trim() || !track.artist?.trim()) return null;

    const deps = getImportSearchDeps();
    // as given, then the core title ("Song - Single Version" -> "Song"), then the first of several artists
    for (const form of searchForms(track.title, track.artist)) {
        const { results } = await searchTracks({ title: form.title, artist: form.artist }, deps, SEARCH_RESULTS_CONSIDERED);
        const accepted = acceptSearchResult(results, track, {
            minScore: deps.config.bestResultMinScore,
            durationMinScore: IMPORT_DURATION_MIN_SCORE
        });
        if (accepted) return { recordingId: accepted.id, via: "search" };
    }
    return null;
}
