// validation for the play-event ingestion endpoint.
//
// SECURITY: everything in a play-event batch is attacker-controlled - the endpoint is authenticated, but an
// authenticated user is still free to POST whatever they like. The rules here exist so that the worst a
// hostile client can do to its *own* insights is make them wrong, and so that nothing it sends can reach the
// database as an unexpected type, an out-of-range number, or a value outside the column's ENUM.
//
// Deliberately absent: album_id and artist_id. The client is not trusted to say which album or artist a
// track belongs to - the server resolves both from the `media` row (see enrichEvents in
// server/core/playEvents.ts). Anything the client sends for them is ignored outright rather than validated,
// because there is no version of "the client says this play was by Artist X" that is worth trusting.
import { isUuid } from "./ids";
import { isPlaySource, type PlaySource } from "./insightsPeriod";

export const MAX_BATCH_SIZE = 50;

// a single play can't sensibly exceed a day; the cap also keeps duration_ms inside INT UNSIGNED
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

// how far out of the present a client-supplied start time may sit. Backdating is allowed within a week so
// events queued offline still land in the right day; future-dating is allowed only enough to absorb ordinary
// clock skew, since a far-future event would otherwise sit at the top of "recent" forever.
const MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FUTURE_MS = 5 * 60 * 1000;

export interface PlayEventInput {
    eventId: string,
    trackId: string,
    playlistId: string | null,
    startedAtMs: number,
    durationMs: number,
    completed: boolean,
    source: PlaySource
}

export interface ParsedBatch {
    events: PlayEventInput[],
    /** count of entries dropped for being malformed, reported back so a client can stop resending them */
    rejected: number
}

function parseOne(raw: unknown, nowMs: number): PlayEventInput | null {
    if (!raw || typeof raw !== "object") return null;
    const e = raw as Record<string, unknown>;

    // event_id is minted client-side so that a retry, a double flush, or the same account flushing from two
    // devices all collapse onto one row via INSERT IGNORE. A non-UUID would defeat that dedup, so it is
    // rejected rather than replaced with a fresh id.
    if (!isUuid(e.event_id) || !isUuid(e.track_id)) return null;

    const playlistId = e.playlist_id === null || e.playlist_id === undefined
        ? null
        : (isUuid(e.playlist_id) ? e.playlist_id : null);

    if (!isPlaySource(e.source)) return null;

    const startedAtMs = Number(e.started_at);
    if (!Number.isFinite(startedAtMs)) return null;
    if (startedAtMs > nowMs + MAX_FUTURE_MS) return null;
    if (startedAtMs < nowMs - MAX_BACKDATE_MS) return null;
    // TIMESTAMP columns can't hold anything before the epoch
    if (startedAtMs <= 0) return null;

    const rawDuration = Number(e.duration_ms);
    if (!Number.isFinite(rawDuration)) return null;
    // clamped rather than rejected: a slightly-too-long duration is a throttled background tab, not an
    // attack, and dropping the event would lose a real listen
    const durationMs = Math.min(MAX_DURATION_MS, Math.max(0, Math.trunc(rawDuration)));

    return {
        eventId: e.event_id,
        trackId: e.track_id,
        playlistId,
        startedAtMs: Math.trunc(startedAtMs),
        durationMs,
        completed: e.completed === true,
        source: e.source
    };
}

export function parsePlayEventBatch(body: unknown): ParsedBatch {
    const rawEvents = (body as { events?: unknown })?.events;
    if (!Array.isArray(rawEvents)) {
        throw createError({ statusCode: 400, statusMessage: "events must be an array" });
    }
    if (rawEvents.length > MAX_BATCH_SIZE) {
        throw createError({ statusCode: 400, statusMessage: `At most ${MAX_BATCH_SIZE} events per request` });
    }

    const nowMs = Date.now();
    const events: PlayEventInput[] = [];
    const seen = new Set<string>();
    let rejected = 0;

    for (const raw of rawEvents) {
        const parsed = parseOne(raw, nowMs);
        if (!parsed) {
            rejected++;
            continue;
        }
        // duplicate ids inside one batch would make the multi-row INSERT hit itself
        if (seen.has(parsed.eventId)) {
            rejected++;
            continue;
        }
        seen.add(parsed.eventId);
        events.push(parsed);
    }

    return { events, rejected };
}
