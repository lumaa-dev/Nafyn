// GET /api/v1/artist/{aid}/image - just the artist's picture. Search results list dozens of artists and finding
// a picture takes up to three upstream calls each (MusicBrainz links, TheAudioDB, Last.fm), so the search
// response leaves it out (apart from pictures already known) and the page asks for the rest one by one.
import { getMusicBrainzRepository } from "~~/server/utils/musicbrainz";
import { MusicBrainzError } from "~~/server/utils/musicbrainzRepository";
import { peekArtistImage, resolveArtistImage } from "~~/server/utils/artistImage";
import { assertMbid } from "~~/server/utils/ids";
import { enforceUpstreamLookupLimit } from "~~/server/utils/rateLimit";

defineRouteMeta({
    openAPI: {
        description: "Get an artist's picture: the Last.fm profile photo MusicBrainz links to the artist; without such a link TheAudioDB, then Last.fm. `image` is null when none has one.",
        tags: ["artist"],
        operationId: "getArtistImage",
        parameters: [
            { name: "aid", in: "path", required: true, description: "MusicBrainz artist ID", schema: { type: "string" } }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["image"],
                            properties: { image: { type: "string", nullable: true } }
                        }
                    }
                }
            },
            "400": { description: "Invalid artist ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No artist found for that ID", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Too many lookups", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "503": { description: "MusicBrainz is unavailable", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    }
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);
    enforceUpstreamLookupLimit(event, userId);

    const aid = assertMbid(getRouterParam(event, "aid"), "artist ID");

    const known = peekArtistImage(aid);
    // undefined = never looked at; null = looked, there is none (no need to ask MusicBrainz again)
    if (known !== undefined) return { image: known };

    // same lookup (and so the same cached response) as the artist page
    let artist;
    try {
        artist = await getMusicBrainzRepository().lookup("artist", aid, ["url-rels"]);
    } catch (error) {
        if (error instanceof MusicBrainzError && error.status === 503) {
            setResponseHeader(event, "Retry-After", 30);
            throw createError({ statusCode: 503, statusMessage: "MusicBrainz is unavailable, try again later" });
        }
        throw createError({ statusCode: 404, statusMessage: "No artist found for that ID" });
    }

    return { image: await resolveArtistImage(aid, artist.name, artist.relations ?? []) };
});
