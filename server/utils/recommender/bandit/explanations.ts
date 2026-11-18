// Joint optimization of what is recommended and why (McInerney et al., "Explore, Exploit, and Explain",
// RecSys 2018): an action is an (item, explanation) pair, and a validity function decides which pairs may
// exist at all, so the bandit only ever chooses between explanations that are true.
//
// "Because you listened to Daft Punk" on a track that has nothing to do with Daft Punk, or "New release" on
// a 1975 album, are lies; they never reach the scorer.
import type { ExplanationKind, ItemKind } from "./features";

export interface Explanation {
    kind: ExplanationKind,
    /** what the explanation names: an artist name, a mix title - display text, never an id */
    subject?: string
}

export interface ExplainableItem {
    kind: ItemKind,
    owned: boolean,
    /** release date, ms since the epoch */
    releasedAt: number | null,
    /** when the user last played it, ms */
    lastPlayedAt: number | null,
    /** when it entered the user's library, ms */
    addedAt: number | null,
    /** the user's artist this suggestion was found through (similar-artist / similar-recording seed) */
    seedArtist: string | null,
    /** the artists credited on the item */
    artists: string[],
    /** the mix this item belongs to, by title */
    mixTitle: string | null,
    /** 0..1 similarity to what the user played in the last session(s) */
    similarityToRecent: number
}

export interface ExplanationContext {
    now: number,
    /** artist names the user listens to most, lowercased */
    topArtists: ReadonlySet<string>
}

const DAY = 86_400_000;
export const NEW_RELEASE_DAYS = 60;
export const REDISCOVER_DAYS = 60;
export const RECENT_DAYS = 14;
export const SIMILAR_TO_RECENT_MIN = 0.8;

/** Is `explanation` true of `item` for this user right now? */
export function isValidExplanation(item: ExplainableItem, explanation: Explanation, ctx: ExplanationContext): boolean {
    switch (explanation.kind) {
        case "none":
            return true;
        case "because_artist": {
            // named artist must be one the user actually listens to, and must be how the item was found -
            // never the item's own artist (that is "more by", not "because you listened to")
            const seed = item.seedArtist?.toLowerCase();
            if (!seed || explanation.subject?.toLowerCase() !== seed) return false;
            if (!ctx.topArtists.has(seed)) return false;
            return !item.artists.some((a) => a.toLowerCase() === seed);
        }
        case "from_mix":
            return item.kind !== "mix" && !!item.mixTitle && explanation.subject === item.mixTitle;
        case "new_release":
            return item.releasedAt !== null && item.releasedAt <= ctx.now && ctx.now - item.releasedAt <= NEW_RELEASE_DAYS * DAY;
        case "rediscover": {
            if (!item.owned) return false;
            const last = item.lastPlayedAt ?? item.addedAt;
            return last !== null && ctx.now - last >= REDISCOVER_DAYS * DAY;
        }
        case "recently_played":
            return (item.kind === "album" || item.kind === "playlist" || item.kind === "mix")
                && item.lastPlayedAt !== null && ctx.now - item.lastPlayedAt <= RECENT_DAYS * DAY;
        case "similar_to_recent":
            return !item.owned && item.similarityToRecent >= SIMILAR_TO_RECENT_MIN;
    }
}

/** every valid (item, explanation) pair for one item - "none" always among them */
export function validExplanations(item: ExplainableItem, ctx: ExplanationContext): Explanation[] {
    const candidates: Explanation[] = [{ kind: "none" }];
    if (item.seedArtist) candidates.push({ kind: "because_artist", subject: item.seedArtist });
    if (item.mixTitle) candidates.push({ kind: "from_mix", subject: item.mixTitle });
    candidates.push({ kind: "new_release" }, { kind: "rediscover" }, { kind: "recently_played" }, { kind: "similar_to_recent" });
    return candidates.filter((e) => isValidExplanation(item, e, ctx));
}
