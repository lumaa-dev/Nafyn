// Orders Soulseek search results for download. Pure (no Nitro auto-imports), so it runs under `bun test`.
//
// A peer's filename is the weakest evidence there is - for a non-Latin title it is often a romanization, mojibake
// or a different spelling than the one searched - but the length the peer's client reports for the file is
// independent of any spelling. So the candidates are tried in order of how close that length is to the one
// MusicBrainz has for the recording: the nearest first, the furthest last, and when the first one fails the
// fingerprint check the next nearest is downloaded.

export interface RankableResult {
    // seconds, as the peer's file reports it (slskd `length`); absent when the peer shares no tag info
    length?: number,
    bitrate?: number,
    speed?: number
}

// further than this from MusicBrainz' length and verification rejects the file anyway (see downloads.ts), so a
// file of unknown length is still worth trying before one this far off
export const DURATION_TOLERANCE_SECONDS = 5;

function knownLength(result: RankableResult): number | null {
    return typeof result.length === "number" && Number.isFinite(result.length) && result.length > 0 ? result.length : null;
}

// 0 = within tolerance, 1 = length unknown, 2 = known and too far off
function band(delta: number | null): 0 | 1 | 2 {
    if (delta === null) return 1;
    return delta <= DURATION_TOLERANCE_SECONDS ? 0 : 2;
}

// `wantedSeconds` <= 0 means MusicBrainz has no length: nothing to rank by, so the order is quality alone.
// The sort is stable, so results the same distance away (or all of them, without a wanted length) keep the order
// they came in - the preferred seller's files first.
export function rankByDuration<T extends RankableResult>(results: T[], wantedSeconds: number): T[] {
    const quality = (a: T, b: T) => (b.bitrate ?? 0) - (a.bitrate ?? 0) || (b.speed ?? 0) - (a.speed ?? 0);
    if (!(wantedSeconds > 0)) return [...results].sort(quality);

    const scored = results.map((result) => {
        const length = knownLength(result);
        const delta = length === null ? null : Math.abs(length - wantedSeconds);
        return { result, delta, band: band(delta) };
    });

    return scored
        .sort((a, b) =>
            a.band - b.band
            || (a.delta ?? 0) - (b.delta ?? 0)
            || quality(a.result, b.result))
        .map((entry) => entry.result);
}
