// paginated playlist entries, used to page further through a playlist beyond the first page embedded in GET /playlist/{pid}
import { getPlaylistById, getEntries, countEntries, hasAccess } from "~~/server/core/playlists";
import { getUserById } from "~~/server/core/users";
import { verifyAuthToken } from "~~/server/utils/jwt";
import { parsePagination, paginated, paginationQueryParams, paginatedResponseSchema } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "List a playlist's tracks, paginated. Public playlists are readable by anonymous visitors (an Authorization header is optional here); private ones require owner/member access",
        tags: ["playlist"],
        operationId: "getPlaylistTracks",
        parameters: [
            {
                name: "pid",
                in: "path",
                required: true,
                description: "Playlist ID",
                schema: { type: "string" }
            },
            ...paginationQueryParams
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: paginatedResponseSchema("#/components/schemas/PlaylistEntry")
                    }
                }
            },
            "400": {
                description: "Missing playlist ID",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Playlist not found, or private and not accessible to the requester",
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
                    PlaylistEntry: {
                        type: "object",
                        required: ["entryId", "addedBy", "position", "addedAt", "media"],
                        properties: {
                            entryId: { type: "string" },
                            addedBy: { $ref: "#/components/schemas/NafynUser" },
                            position: { type: "number" },
                            addedAt: { type: "number", description: "Unix timestamp (milliseconds)" },
                            media: { $ref: "#/components/schemas/MediaRow" }
                        }
                    }
                }
            }
        }
    },
});

export default defineEventHandler(async (event) => {
    const pid = getRouterParam(event, "pid");
    if (!pid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist ID" });
    }

    const playlist = await getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    // best-effort auth: anonymous visitors are allowed on public playlists, so a missing/invalid token isn't fatal here
    let userId: string | null = null;
    const auth = getHeader(event, "Authorization");
    if (auth?.startsWith("Bearer ")) {
        try {
            userId = verifyAuthToken(auth.slice("Bearer ".length).trim()).sub;
        } catch {
            userId = null;
        }
    }

    const isOwner = userId === playlist.ownerId;
    const isMember = !!userId && await hasAccess(playlist, userId);

    if (playlist.privacy === "private" && !isOwner && !isMember) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    const pagination = parsePagination(event);
    const [rows, total] = await Promise.all([
        getEntries(playlist.id, pagination.limit, pagination.offset),
        countEntries(playlist.id)
    ]);

    const items = await Promise.all(rows.map(async (entry) => ({
        entryId: entry.entryId,
        addedBy: await getUserById(entry.addedBy, true),
        position: entry.position,
        addedAt: entry.addedAt,
        media: entry.media
    })));

    return paginated(items, total, pagination);
});
