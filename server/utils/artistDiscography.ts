// How an artist's release-groups are laid out on their page: grouped by what kind of release they are (Albums,
// EPs, Singles, Compilations...), newest first, with the Deluxe / Remaster edition of an album that is a release
// inside the album's own release-group ("Pinkerton (Deluxe Edition)" is not a release-group of its own) shown as a
// release of its own next to the standard one. Pure (no Nitro auto-imports, no network), so it runs under `bun test`.

import type { SearchConfig } from "./search/config";
import { hasDeluxeKeyword, hasRemasterKeyword, sortableDate } from "./search/filters";
import type { RawRelease } from "./search/types";

export type ReleaseCategoryId = "album" | "ep" | "single" | "compilation" | "live" | "remix" | "soundtrack" | "other";

/** The order the categories are listed in. */
export const CATEGORY_ORDER: ReleaseCategoryId[] = ["album", "ep", "single", "compilation", "live", "remix", "soundtrack", "other"];

/**
 * The category of a release-group. A secondary type says more than the primary one - a live album is "Live", not
 * "Albums" - in this order: live, remix, compilation, soundtrack; then the primary type; anything else is "Other"
 * (broadcasts, demos, mixtapes, spoken word...).
 */
export function releaseCategory(primaryType: string | null | undefined, secondaryTypes: string[] | undefined): ReleaseCategoryId {
    const secondary = new Set((secondaryTypes ?? []).map((type) => type.toLowerCase()));
    if (secondary.has("live")) return "live";
    if (secondary.has("remix") || secondary.has("dj-mix")) return "remix";
    if (secondary.has("compilation")) return "compilation";
    if (secondary.has("soundtrack")) return "soundtrack";
    if (secondary.has("demo") || secondary.has("mixtape/street") || secondary.has("spokenword") || secondary.has("interview") || secondary.has("audiobook") || secondary.has("audio drama") || secondary.has("field recording")) return "other";
    switch (primaryType?.toLowerCase()) {
        case "album": return "album";
        case "ep": return "ep";
        case "single": return "single";
        default: return "other";
    }
}

/** Categories whose standard editions get their Deluxe / Remaster edition listed next to them (never a live album's). */
const EDITION_CATEGORIES = new Set<ReleaseCategoryId>(["album", "ep"]);

export interface GroupRef {
    id: string,
    title: string,
    category: ReleaseCategoryId
}

export interface EditionPick {
    groupId: string,
    release: RawRelease,
    edition: "deluxe" | "remaster",
    /** What to call it: the release's own title, with its disambiguation when the title alone does not say. */
    title: string
}

function editionLabel(release: RawRelease): string {
    return `${release.title ?? ""} ${release.disambiguation ?? ""}`;
}

/**
 * The Deluxe / Remaster editions to list: from `releases` (a release search), those that belong to one of the
 * `groups`, whose group is an album or EP that is not itself a Deluxe / Remaster edition, and that are not simply
 * the standard release under another country. One per group and edition kind - the earliest, and among those the
 * one `covered` says has a front cover.
 */
export function pickEditions(releases: RawRelease[], groups: Map<string, GroupRef>, config: SearchConfig, covered: (release: RawRelease) => boolean = () => true): EditionPick[] {
    const picks = new Map<string, EditionPick[]>();

    for (const release of releases) {
        if (release.status?.toLowerCase() !== "official") continue;
        const group = release["release-group"]?.id ? groups.get(release["release-group"].id) : undefined;
        if (!group || !EDITION_CATEGORIES.has(group.category)) continue;
        // a group that is itself the edition already has its own card
        if (hasDeluxeKeyword(group.title, config) || hasRemasterKeyword(group.title, config)) continue;

        const label = editionLabel(release);
        const edition = hasDeluxeKeyword(label, config) ? "deluxe" : hasRemasterKeyword(label, config) ? "remaster" : null;
        if (!edition) continue;

        const own = (release.title ?? "").trim();
        const disambiguation = (release.disambiguation ?? "").trim();
        const named = hasDeluxeKeyword(own, config) || hasRemasterKeyword(own, config);
        const title = !own ? group.title : named || !disambiguation ? own : `${own} (${disambiguation})`;

        const key = `${group.id}|${edition}`;
        const list = picks.get(key) ?? [];
        list.push({ groupId: group.id, release, edition, title });
        picks.set(key, list);
    }

    const chosen: EditionPick[] = [];
    for (const list of picks.values()) {
        // earliest first; one with a cover wins over an earlier one without
        list.sort((a, b) => sortableDate(a.release.date).localeCompare(sortableDate(b.release.date)) || a.release.id.localeCompare(b.release.id));
        chosen.push(list.find((pick) => covered(pick.release)) ?? list[0]!);
    }
    return chosen;
}

export interface DatedRelease {
    date: Date | null,
    /** The standard edition before an edition released the same day. */
    edition: boolean
}

/** Newest first, undated last, the standard edition before an edition of the same day. */
export function compareNewestFirst(a: DatedRelease, b: DatedRelease): number {
    const dateA = a.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    const dateB = b.date?.getTime() ?? Number.NEGATIVE_INFINITY;
    if (dateA !== dateB) return dateB - dateA;
    return Number(a.edition) - Number(b.edition);
}
