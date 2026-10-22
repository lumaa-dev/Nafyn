// shared MusicBrainz release selection.
//
// A release-group ("Are We There Yet?") holds many releases: the standard edition, a digital deluxe with
// +45 tracks, promos, bootlegs, region reissues. Every part of Nafyn that turns a release-group (or a
// recording) into concrete metadata used to pick its own release - the album page took the first "Digital
// Media" release, the track page did the same over a different include set, and the download pipeline took
// `releases[0]`. Three call sites, three answers, so the tracklist a user browsed was frequently not the
// one the downloader tagged files against (and often an edition whose extra tracks are simply not
// obtainable on Soulseek at all).
//
// `pickCanonicalRelease` is the single answer to "which release *is* this album". Every caller uses it.

import type { IRelease, IReleaseGroup } from "musicbrainz-api";

// MusicBrainz release statuses. Anything that isn't an official commercial release is a different artefact
// with a different (often wrong, often unobtainable) tracklist: promos carry radio edits, bootlegs carry
// audience recordings, pseudo-releases are transliterations of an existing release.
const OFFICIAL_STATUS = "official";

// edition markers: a release titled/disambiguated with one of these is an alternate edition of the album
// rather than the album itself, unless the release group is genuinely named that way
const EDITION_KEYWORDS = [
    "deluxe", "expanded", "anniversary", "edition", "remaster", "remastered", "reissue",
    "bonus", "special", "collector", "complete", "extended", "super", "platinum", "gold",
    "tour edition", "japanese", "japan", "instrumental", "acoustic", "live"
];

function lower(value: string | undefined | null): string {
    return (value ?? "").toLowerCase();
}

export function releaseStatus(release: IRelease): string {
    return lower(release.status);
}

// true unless MusicBrainz explicitly marks the release as something other than official. An absent status
// is treated as official: plenty of legitimate releases carry no status, and dropping them would leave
// some albums with no usable release at all.
export function isOfficialRelease(release: IRelease): boolean {
    const status = releaseStatus(release);
    return status === "" || status === OFFICIAL_STATUS;
}

// true when the Cover Art Archive holds a front image for the release. MusicBrainz includes this summary on
// every release in a lookup/browse, so no extra include or request is needed. `darkened` marks art taken down
// by the archive (its image URL no longer serves), so it doesn't count.
export function hasFrontCover(release: IRelease): boolean {
    const archive = release["cover-art-archive"];
    return archive?.front === true && archive.darkened !== true;
}

function trackCount(release: IRelease): number {
    const media = release.media ?? [];
    if (media.length === 0) return 0;
    return media.reduce((total, medium) => total + (medium["track-count"] ?? medium.tracks?.length ?? 0), 0);
}

// an edition marker that the release group's own title already carries isn't a marker at all
// ("MTV Unplugged" is the album, not a special edition of it)
function editionPenalty(release: IRelease, releaseGroupTitle: string): number {
    const haystack = `${lower(release.title)} ${lower(release.disambiguation)}`;
    const groupTitle = lower(releaseGroupTitle);
    const hits = EDITION_KEYWORDS.filter((keyword) => haystack.includes(keyword) && !groupTitle.includes(keyword));
    return hits.length;
}

export interface ReleasePickOptions {
    /** The release group's title, used to spot alternate editions (a retitled/disambiguated release). */
    releaseGroupTitle?: string,
    /** The release group's `first-release-date`; the original edition normally shares it. */
    firstReleaseDate?: string,
    /** Median track count across candidates, computed internally; exposed for testing. */
    medianTracks?: number
}

function scoreRelease(release: IRelease, options: ReleasePickOptions, medianTracks: number): number {
    let score = 0;

    // 1. official above everything else - a promo/bootleg tracklist is the wrong tracklist
    const status = releaseStatus(release);
    if (status === OFFICIAL_STATUS) score += 10000;
    else if (status === "") score += 5000;

    // 2. a release with a front cover is far more likely to be the one people know, and it is the one whose
    //    cover art (written into tags, shown on cards and the track page) actually exists. A strong nudge
    //    among releases of the same status, but never enough to outweigh status (above) or pull in a
    //    deluxe over the standard edition (edition penalty, below, is applied per keyword).
    if (hasFrontCover(release)) score += 700;

    // 3. the release that carries the album's own name, undecorated, is the album
    if (options.releaseGroupTitle && lower(release.title) === lower(options.releaseGroupTitle)) score += 800;
    score -= editionPenalty(release, options.releaseGroupTitle ?? "") * 600;

    // 4. the original edition normally comes out on the release group's first release date; deluxes and
    //    reissues land later
    if (options.firstReleaseDate && release.date && release.date.startsWith(options.firstReleaseDate)) score += 400;

    // 5. digital media is what Nafyn actually distributes, and its tracklist matches streaming services
    if (release.media?.some((medium) => medium.format === "Digital Media")) score += 200;

    // 6. a release far larger than its siblings is a deluxe/box set. Penalize the *distance above* the
    //    median rather than size outright, so a genuinely long album isn't punished for existing.
    const tracks = trackCount(release);
    if (tracks > 0 && medianTracks > 0 && tracks > medianTracks) {
        score -= Math.min((tracks - medianTracks) * 20, 1000);
    }

    // 7. tiebreaker: a release with an actual tracklist beats one with none
    if (tracks > 0) score += 10;

    return score;
}

// picks the release that best represents the release group, or the recording's own release list.
// Returns undefined only when `releases` is empty.
export function pickCanonicalRelease(releases: IRelease[] | undefined, options: ReleasePickOptions = {}): IRelease | undefined {
    if (!releases || releases.length === 0) return undefined;
    if (releases.length === 1) return releases[0];

    const counts = releases.map(trackCount).filter((count) => count > 0).sort((a, b) => a - b);
    const medianTracks = options.medianTracks
        ?? (counts.length > 0 ? counts[Math.floor((counts.length - 1) / 2)]! : 0);

    let best: IRelease | undefined;
    let bestScore = -Infinity;
    for (const release of releases) {
        const score = scoreRelease(release, options, medianTracks);
        if (score > bestScore) {
            best = release;
            bestScore = score;
        }
    }
    return best;
}

// convenience wrapper for the common "release group + its browsed releases" case
export function pickReleaseForGroup(releaseGroup: IReleaseGroup, releases: IRelease[] | undefined): IRelease | undefined {
    return pickCanonicalRelease(releases, {
        releaseGroupTitle: releaseGroup.title,
        firstReleaseDate: releaseGroup["first-release-date"]
    });
}
