import type { IReleaseGroup } from "musicbrainz-api";
import { getMusicBrainzRepository, parseReleaseDate } from "~~/server/utils/musicbrainz";
import { getLastfmArtistInfo } from "~~/server/utils/lastfm";
import { resolveArtistImage } from "~~/server/utils/artistImage";
import { userOwnsAlbum } from "~~/server/core/library";
import type { ArtistDetail, ArtistRelease, ReleaseCategory } from "~~/server/entity/media/ArtistDetail";
import type { MediaInfo } from "~~/server/entity/media/MediaInfo";
import { CATEGORY_ORDER, compareNewestFirst, pickEditions, releaseCategory, type GroupRef } from "~~/server/utils/artistDiscography";
import { getSearchDeps } from "~~/server/utils/catalogSearch";
import type { ReleaseSearch } from "~~/server/utils/search/types";
import { assertMbid } from "~~/server/utils/ids";
import { enforceUpstreamLookupLimit } from "~~/server/utils/rateLimit";
import { luceneQuote } from "~~/server/utils/musicbrainzRepository";

defineRouteMeta({
    openAPI: {
        description: "Get artist details: name, picture, Last.fm bio (if LASTFM_API_KEY is configured), and their discography from MusicBrainz with per-album library status for the requesting user. `categories` lays the discography out by kind (Albums, EPs, Singles, Compilations, Live, Remixes, Soundtracks, Other), newest first, and adds the Deluxe / Remaster edition of an album when it is a release inside the album's own release-group",
        tags: ["artist"],
        operationId: "getArtist",
        parameters: [
            {
                name: "aid",
                in: "path",
                required: true,
                description: "MusicBrainz artist ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/ArtistDetail" }
                    }
                }
            },
            "400": {
                description: "Missing artist ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "401": {
                description: "Not authenticated",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "No artist found for that ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            }
        },
        $global: {
            components: {
                schemas: {
                    ArtistDetail: {
                        type: "object",
                        required: ["id", "name", "image", "bio", "listeners", "albums", "categories"],
                        properties: {
                            id: { type: "string", description: "MusicBrainz artist ID" },
                            name: { type: "string" },
                            image: { type: "string", nullable: true, description: "The Last.fm profile photo MusicBrainz links to the artist; without a link, TheAudioDB then Last.fm. Null when none has one" },
                            bio: { type: "string", nullable: true, description: "From Last.fm" },
                            listeners: { type: "number", nullable: true, description: "Last.fm listener count" },
                            albums: {
                                type: "array",
                                description: "Every release-group, newest first, all kinds mixed",
                                items: { $ref: "#/components/schemas/MediaInfo" }
                            },
                            categories: {
                                type: "array",
                                description: "The discography by kind, in display order; kinds with nothing in them are left out",
                                items: { $ref: "#/components/schemas/ReleaseCategory" }
                            }
                        }
                    },
                    ReleaseCategory: {
                        type: "object",
                        required: ["id", "releases"],
                        properties: {
                            id: { type: "string", enum: ["album", "ep", "single", "compilation", "live", "remix", "soundtrack", "other"], description: "Clients name it (\"Albums\", \"EPs\"...)" },
                            releases: { type: "array", items: { $ref: "#/components/schemas/ArtistRelease" }, description: "Newest first" }
                        }
                    },
                    ArtistRelease: {
                        allOf: [{ $ref: "#/components/schemas/MediaInfo" }],
                        type: "object",
                        required: ["releaseId", "edition"],
                        properties: {
                            releaseId: { type: "string", nullable: true, description: "The release to open the album on (`GET /album/{id}?release=`); null for the release-group itself" },
                            edition: { type: "string", enum: ["deluxe", "remaster"], nullable: true, description: "Set on the Deluxe / Remaster edition of an album that has a standard one; `id` is then still the album's release-group" }
                        }
                    }
                }
            }
        }
    },
});

const BROWSE_PAGE = 100;
// a prolific artist has hundreds of release-groups; past this nobody scrolls, and each page is a request
const MAX_BROWSE_PAGES = 5;

async function browseReleaseGroups(client: ReturnType<typeof getMusicBrainzRepository>, aid: string): Promise<IReleaseGroup[]> {
    const groups: IReleaseGroup[] = [];
    for (let page = 0; page < MAX_BROWSE_PAGES; page++) {
        // the first page failing leaves an empty discography (as before); a later one just stops the listing there
        const browsed = await client.browse("release-group", { artist: aid, limit: BROWSE_PAGE, offset: page * BROWSE_PAGE } as never, ["artist-credits"]).catch(() => null);
        if (!browsed) break;
        groups.push(...browsed["release-groups"]);
        const total = (browsed as unknown as { "release-group-count"?: number })["release-group-count"] ?? 0;
        if (browsed["release-groups"].length < BROWSE_PAGE || groups.length >= total) break;
    }
    return groups;
}

// words that make a release a Deluxe / Remaster edition, as the release search wants them
const EDITION_QUERY = `release:(deluxe OR expanded OR remaster OR remastered OR ${luceneQuote("anniversary edition")} OR ${luceneQuote("special edition")} OR ${luceneQuote("extended edition")}) OR comment:(deluxe OR expanded OR remaster OR remastered)`;

/** Never throws: without the editions the artist page is the plain discography. */
async function findEditions(aid: string, groups: Map<string, GroupRef>) {
    const deps = getSearchDeps();
    try {
        const found = [];
        for (let page = 0; page < 2; page++) {
            const response = await deps.repo.request<ReleaseSearch>("/release", { query: `arid:${aid} AND status:official AND (${EDITION_QUERY})`, limit: 100, offset: page * 100 });
            const releases = response.releases ?? [];
            found.push(...releases);
            if (releases.length < 100) break;
        }
        const picks = pickEditions(found, groups, deps.config);
        // which of the picks really have a cover: the search payload says nothing about that
        const covered = new Set<string>();
        await Promise.all(picks.map(async (pick) => {
            if (await deps.cover.hasFront({ releaseId: pick.release.id, releaseGroupId: null })) covered.add(pick.release.id);
        }));
        return picks.map((pick) => ({ ...pick, covered: covered.has(pick.release.id) }));
    } catch (error) {
        console.warn(`[artist] could not look up the editions of ${aid}: ${(error as Error).message}`);
        return [];
    }
}

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    enforceUpstreamLookupLimit(event, userId);

    // SECURITY: see the note in track/[tid].get.ts - this reaches an upstream MusicBrainz REST path
    const aid = assertMbid(getRouterParam(event, "aid"), "artist ID");

    const client = getMusicBrainzRepository();

    const artist = await client.lookup("artist", aid, ["url-rels"]).catch(() => null);
    if (!artist) {
        throw createError({ statusCode: 404, statusMessage: "No artist found for that ID" });
    }

    const [releaseGroups, lastfm, image] = await Promise.all([
        browseReleaseGroups(client, aid),
        getLastfmArtistInfo(artist.name, aid),
        resolveArtistImage(aid, artist.name, artist.relations ?? [])
    ]);

    // newest first, undated last; secondary types (live/compilation/remix/...) stay in rather than being filtered
    // out - they get their own category
    releaseGroups.sort((a, b) => (b["first-release-date"] ?? "").localeCompare(a["first-release-date"] ?? ""));

    const toRelease = async (rg: IReleaseGroup): Promise<ArtistRelease> => {
        const primaryType = rg["primary-type"]?.toLowerCase();
        const type = primaryType === "album" || primaryType === "ep" ? primaryType : null;

        return {
            id: rg.id,
            title: rg.title,
            artist: artist.name,
            album: { id: rg.id, type, title: rg.title },
            type,
            coverArt: `https://coverartarchive.org/release-group/${rg.id}/front-250`,
            releaseDate: parseReleaseDate(rg["first-release-date"]),
            inLibrary: await userOwnsAlbum(userId, rg.id),
            duration: 0,
            label: null,
            releaseId: null,
            edition: null
        };
    };
    const releases: ArtistRelease[] = await Promise.all(releaseGroups.map(toRelease));
    const albums = releases.map(({ releaseId: _releaseId, edition: _edition, ...media }) => media) as MediaInfo[];

    // the Deluxe / Remaster edition of an album that is a release inside the album's release-group
    const groups = new Map<string, GroupRef>(releaseGroups.map((rg) => [rg.id, { id: rg.id, title: rg.title, category: releaseCategory(rg["primary-type"], rg["secondary-types"]) }]));
    const editions = await findEditions(aid, groups);

    const byKind = new Map<string, ArtistRelease[]>();
    const add = (release: ArtistRelease, category: string) => byKind.set(category, [...(byKind.get(category) ?? []), release]);
    releases.forEach((release, index) => add(release, groups.get(releaseGroups[index]!.id)!.category));
    for (const edition of editions) {
        const standard = releases.find((release) => release.id === edition.groupId)!;
        add({
            ...standard,
            title: edition.title,
            coverArt: edition.covered
                ? `https://coverartarchive.org/release/${edition.release.id}/front-250`
                : standard.coverArt,
            releaseDate: parseReleaseDate(edition.release.date) ?? standard.releaseDate,
            releaseId: edition.release.id,
            edition: edition.edition
        }, groups.get(edition.groupId)!.category);
    }
    const categories: ReleaseCategory[] = CATEGORY_ORDER
        .filter((id) => byKind.has(id))
        .map((id) => ({
            id,
            releases: byKind.get(id)!.sort((a, b) => compareNewestFirst({ date: a.releaseDate, edition: a.edition !== null }, { date: b.releaseDate, edition: b.edition !== null }))
        }));

    const detail: ArtistDetail = {
        id: artist.id,
        name: artist.name,
        image,
        bio: lastfm?.bio ?? null,
        listeners: lastfm?.listeners ?? null,
        albums,
        categories
    };

    return detail;
});
