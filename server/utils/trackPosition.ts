// Where a track sits on its medium, as a plain integer (`media.trackNumber`, the file's `track=` tag).
// Pure: no Nitro auto-imports, so `tests/trackPosition.test.ts` runs under `bun test`.
//
// MusicBrainz gives every track two fields: `position` (1, 2, 3... within the medium, always an integer) and
// `number` (what the sleeve prints: "1", "A1", "B3", "1-04", "CD2-3"...). Only `position` is a track number; a
// vinyl's "B3" is never parsed as one. `number` is the fallback only when it is plainly an integer, and after that
// the track's place in the medium as it was listed.

export interface TrackLike {
    position?: number | string | null,
    number?: string | null
}

export interface MediumLike<T extends TrackLike = TrackLike> {
    position?: number | null,
    tracks?: T[] | null,
    "track-offset"?: number | null
}

function positiveInteger(value: unknown): number | null {
    if (typeof value === "number") return Number.isInteger(value) && value > 0 ? value : null;
    if (typeof value === "string" && /^\s*\d+\s*$/.test(value)) {
        const parsed = Number.parseInt(value, 10);
        return parsed > 0 ? parsed : null;
    }
    return null;
}

/**
 * The track's position within `medium`. `index` is the track's index in `medium.tracks` as listed: a recording
 * lookup lists only the matching track there, with `track-offset` saying where it really is.
 */
export function trackPosition(track: TrackLike, medium?: MediumLike | null, index?: number): number | null {
    const position = positiveInteger(track.position);
    if (position !== null) return position;
    const printed = positiveInteger(track.number);
    if (printed !== null) return printed;
    const offset = medium?.["track-offset"];
    if (typeof offset === "number" && Number.isInteger(offset) && offset >= 0) return offset + 1 + (index ?? 0);
    if (index !== undefined && index >= 0) return index + 1;
    return null;
}

/**
 * The medium and the track a recording is on within one release. In a recording lookup
 * (`/recording/{id}?inc=releases+media`) the tracks carry no `recording` - the only track listed under a medium
 * is that recording's - so a track without one counts as a match there.
 */
export function findRecordingTrack<T extends TrackLike & { recording?: { id?: string } | null }, M extends MediumLike<T>>(
    media: M[] | null | undefined,
    recordingId: string
): { medium: M, track: T, index: number } | null {
    const wanted = recordingId.toLowerCase();
    let loose: { medium: M, track: T, index: number } | null = null;
    for (const medium of media ?? []) {
        for (const [index, track] of (medium.tracks ?? []).entries()) {
            const id = track.recording?.id;
            if (id && id.toLowerCase() === wanted) return { medium, track, index };
            // a track with no recording: a recording lookup, where it can only be this recording's
            if (!id && !loose) loose = { medium, track, index };
        }
    }
    return loose;
}
