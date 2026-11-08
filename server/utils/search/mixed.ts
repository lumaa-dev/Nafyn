// One list for the whole search: tracks, albums and artists in a single ranking, the most likely answer first.
//
// The engine ranks albums and tracks each on its own (cover first, then relevance...), and MusicBrainz' artist
// search ranks artists on its own score. Here the three are put on one scale - the 0..1 relevance every album and
// track already carries, and the same kind of name similarity for an artist - and interleaved WITHOUT reordering
// any of the lists: each keeps the order its own ranking gave it (so the engine's cover-first and tie-break rules
// still apply inside a kind), and the next row is whichever list's head is the most likely. Nothing in here
// imports Nitro auto-imports, so it runs under `bun test`.

import type { SearchConfig } from "./config";
import { normalizeText } from "./normalize";
import { latinize, needsLatinForm } from "./script";
import { nameSimilarity } from "./similarity";
import type { RawArtistHit } from "./types";

export type EntryKind = "track" | "album" | "artist";

export interface RankedEntry<T> {
    kind: EntryKind,
    /** 0..1, may exceed 1 for a result carrying code bonuses; comparable across kinds. */
    relevance: number,
    item: T
}

/**
 * How well an artist matches what was typed, 0..1: the best name similarity over the artist's name, sort name and
 * aliases (and the Latin spelling of any of them written in another script).
 */
export function artistRelevance(query: string, hit: Pick<RawArtistHit, "name" | "sort-name" | "aliases">, config: SearchConfig): number {
    const requested = normalizeText(query, config);
    if (requested.distinctive.length === 0 && requested.cjk.length === 0) return 0;

    const names = new Set<string>();
    for (const name of [hit.name, hit["sort-name"], ...(hit.aliases ?? []).flatMap((alias) => [alias.name, alias["sort-name"]])]) {
        if (name) names.add(name);
    }
    for (const name of [...names]) if (needsLatinForm(name)) names.add(latinize(name));

    let best = 0;
    for (const name of names) {
        const normalized = normalizeText(name, config);
        if (normalized.distinctive.length === 0 && normalized.cjk.length === 0) continue;
        best = Math.max(best, nameSimilarity(requested, normalized, config));
    }
    return best;
}

// when two rows are equally likely: the artist (what was typed is the name), then the album, then the track
const KIND_PRIORITY: Record<EntryKind, number> = { artist: 0, album: 1, track: 2 };

const RESOLUTION = 1000;

/** Interleaves already-ranked lists: the next row is the likeliest head; no list is ever reordered. */
export function mergeByLikelihood<T>(...lists: Array<Array<RankedEntry<T>>>): Array<RankedEntry<T>> {
    const cursors = lists.map(() => 0);
    const merged: Array<RankedEntry<T>> = [];
    for (;;) {
        let pick = -1;
        for (let index = 0; index < lists.length; index++) {
            const head = lists[index]![cursors[index]!];
            if (!head) continue;
            if (pick === -1) {
                pick = index;
                continue;
            }
            const current = lists[pick]![cursors[pick]!]!;
            const a = Math.round(head.relevance * RESOLUTION);
            const b = Math.round(current.relevance * RESOLUTION);
            if (a > b || (a === b && KIND_PRIORITY[head.kind] < KIND_PRIORITY[current.kind])) pick = index;
        }
        if (pick === -1) return merged;
        merged.push(lists[pick]![cursors[pick]!++]!);
    }
}
