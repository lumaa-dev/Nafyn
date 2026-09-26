import { lookupMetadata } from "../../../utils/metadata";
import { parseMetadataQuery } from "../../../utils/metadata/query";
import { requireAuthToken } from "../../../utils/requireAuth";
import { consumeRateLimit } from "../../../utils/rateLimit";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;

// every call fans out to up to six upstreams (plus MusicBrainz), all rate limited per Nafyn IP - one account
// must not be able to burn the whole install's quota
const MAX_LOOKUPS = 30;
const LOOKUP_WINDOW_MS = 60 * 1000;

defineRouteMeta({
    openAPI: {
        description: "Look up song metadata across Deezer, iTunes, ReccoBeats, Discogs, TheAudioDB and Genius (providers without a configured key are skipped). `q` is free text (`Artist - Title` enables fielded searches), an ISRC, a platform ID (`deezer:track:3135556`, `itunes:1440857781`, `spotify:track:<id>`, `discogs:release:249504`, `genius:song:378195`, `theaudiodb:track:32724184`) or a supported Deezer/Apple Music/Spotify/Discogs/Genius/TheAudioDB link",
        tags: ["search"],
        operationId: "searchMetadata",
        parameters: [
            { name: "q", in: "query", required: true, description: "Text, ISRC, platform ID or link", schema: { type: "string" } },
            { name: "limit", in: "query", required: false, description: `Max results per provider for text searches, defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}`, schema: { type: "number" } }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["query", "musicbrainzId", "results", "providers"],
                            properties: {
                                query: { type: "object", description: "How `q` was understood: `{ type: \"text\" | \"isrc\" | \"id\", ... }`" },
                                musicbrainzId: { type: "string", nullable: true, description: "MusicBrainz recording the ISRC/ID lookup resolved to, always null for text searches" },
                                providers: { type: "array", items: { type: "string" }, description: "Providers enabled on this server" },
                                results: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            provider: { type: "string", enum: ["deezer", "itunes", "reccobeats", "discogs", "theaudiodb", "genius"] },
                                            ref: { type: "string", description: "Platform ID to look this record up again with" },
                                            kind: { type: "string", enum: ["track", "album"] },
                                            title: { type: "string" },
                                            artists: { type: "array", items: { type: "string" } },
                                            album: { type: "string", nullable: true },
                                            duration: { type: "number", nullable: true, description: "Seconds" },
                                            isrc: { type: "string", nullable: true },
                                            releaseDate: { type: "string", nullable: true, description: "`YYYY`, `YYYY-MM` or `YYYY-MM-DD`" },
                                            genres: { type: "array", items: { type: "string" } },
                                            artwork: { type: "array", items: { type: "string" }, description: "Largest first" },
                                            previews: { type: "array", items: { type: "string" } },
                                            url: { type: "string", nullable: true },
                                            musicbrainzId: { type: "string", nullable: true },
                                            extra: { type: "object", description: "Provider-specific extras" }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            },
            "400": { description: "Missing or unsupported `q`", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Too many lookups", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    }
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = requireAuthToken(event);

    const rateLimit = consumeRateLimit(`metadata:${userId}`, MAX_LOOKUPS, LOOKUP_WINDOW_MS);
    if (!rateLimit.allowed) {
        setResponseHeader(event, "Retry-After", rateLimit.retryAfterSeconds);
        throw createError({ statusCode: 429, statusMessage: "Too many lookups, slow down" });
    }

    const query = getQuery(event);
    const q = (typeof query?.q === "string" ? query.q : "").trim().slice(0, 300);
    const parsed = parseMetadataQuery(q);
    if (!parsed) {
        // a link from a site no provider covers, or nothing at all
        throw createError({ statusCode: 400, statusMessage: "Missing or unsupported search query `q`" });
    }

    const limit = Math.min(Math.max(Math.trunc(Number(query?.limit)) || DEFAULT_LIMIT, 1), MAX_LIMIT);
    return lookupMetadata(parsed, limit);
});
