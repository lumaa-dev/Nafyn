import { createImport, hasRunningImport, MAX_IMPORT_TRACKS } from "~~/server/core/imports";
import { getPermissionsById, getUserById } from "~~/server/core/users";
import { hasPermission, Permission } from "~~/server/entity/Permission";
import { collectionToAlbums, DISCOGS_USERNAME, DiscogsError, fetchDiscogsCollection } from "~~/server/utils/discogsCollection";
import { consumeRateLimit } from "~~/server/utils/rateLimit";

defineRouteMeta({
    openAPI: {
        description: `Import a Discogs collection: the server reads the user's public Discogs collection (the \`username\` given, else the Discogs username on the caller's profile) and starts an import of its albums, exactly like POST /api/v1/import with \`albums\` - each one matched to a MusicBrainz release-group by title + artist and requested whole. Several pressings of one album are one item. Needs REQUEST_ALBUMS; at most ${MAX_IMPORT_TRACKS} albums, one running import per user. Can take a few seconds per 100 releases (Discogs' rate limit)`,
        tags: ["import"],
        operationId: "importDiscogsCollection",
        requestBody: {
            required: false,
            content: { "application/json": { schema: { type: "object", properties: { username: { type: "string", description: "Discogs username; defaults to the one on the caller's profile" } } } } }
        },
        responses: {
            "200": { description: "The import, just started", content: { "application/json": { schema: { $ref: "#/components/schemas/PlaylistImport" } } } },
            "400": { description: "No Discogs username, or an empty collection", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "401": { description: "Not authenticated", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "403": { description: "Missing REQUEST_ALBUMS, or the collection is private", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "404": { description: "No Discogs user by that name", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "409": { description: "The caller already has an import running", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "429": { description: "Too many collection imports, or Discogs is rate limiting", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } },
            "502": { description: "Discogs could not be reached", content: { "application/json": { schema: { $ref: "#/components/schemas/NuxtError" } } } }
        }
    },
});

export default defineEventHandler(async (event) => {
    const { sub: userId } = await requireAuthToken(event);

    if (!hasPermission(await getPermissionsById(userId) ?? 0, Permission.REQUEST_ALBUMS)) {
        throw createError({ statusCode: 403, message: "Unsufficient permissions" });
    }

    const body = await readBody(event).catch(() => null) as { username?: unknown } | null;
    const given = typeof body?.username === "string" ? body.username.trim() : "";
    const username = given || (await getUserById(userId))?.discogs?.trim() || "";
    if (!username || !DISCOGS_USERNAME.test(username)) {
        throw createError({ statusCode: 400, message: "No Discogs username: add it to your profile or send one" });
    }

    if (await hasRunningImport(userId)) throw createError({ statusCode: 409, message: "An import is already running" });

    // reading a collection costs up to ten Discogs calls: a few per hour is plenty
    const limit = consumeRateLimit(`discogs-import:${userId}`, 5, 60 * 60 * 1000);
    if (!limit.allowed) {
        setResponseHeader(event, "Retry-After", limit.retryAfterSeconds);
        throw createError({ statusCode: 429, message: "Too many Discogs imports, try again later" });
    }

    let albums;
    try {
        albums = collectionToAlbums(await fetchDiscogsCollection(username, MAX_IMPORT_TRACKS * 2, "Nafyn/1.0 (self-hosted music library)"), MAX_IMPORT_TRACKS);
    } catch (error) {
        if (error instanceof DiscogsError) throw createError({ statusCode: error.status, message: error.message });
        throw error;
    }
    if (albums.length === 0) throw createError({ statusCode: 400, message: "This Discogs collection is empty" });

    return await createImport(userId, { source: "discogs", name: `Discogs: ${username}`, albums });
});
