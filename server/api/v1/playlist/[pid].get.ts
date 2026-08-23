// playlist detail; public playlists are readable by anonymous visitors, private ones require owner/member access
import { getPlaylistById, getMembers, getEntries, countEntries, hasAccess } from "~~/server/core/playlists";
import { getUserById } from "~~/server/core/users";
import { verifyAuthToken } from "~~/server/utils/jwt";
import { parsePagination, paginationQueryParams } from "~~/server/utils/pagination";

defineRouteMeta({
    openAPI: {
        description: "Get playlist details: metadata, owner, members, and the first page of entries (further pages via GET /playlist/{pid}/tracks). Public playlists are readable by anonymous visitors (an Authorization header is optional here); private ones require owner/member access",
        tags: ["playlist"],
        operationId: "getPlaylist",
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
                        schema: {
                            type: "object",
                            required: ["playlist", "owner", "members", "entries", "entriesTotal", "entriesHasMore", "viewer"],
                            properties: {
                                playlist: { $ref: "#/components/schemas/PlaylistRow" },
                                owner: { $ref: "#/components/schemas/NafynUser" },
                                members: {
                                    type: "array",
                                    items: { $ref: "#/components/schemas/NafynUser" }
                                },
                                entries: {
                                    type: "array",
                                    description: "First page of entries; page through the rest via GET /playlist/{pid}/tracks",
                                    items: {
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
                                },
                                entriesTotal: { type: "integer" },
                                entriesHasMore: { type: "boolean" },
                                viewer: {
                                    type: "object",
                                    required: ["userId", "isOwner", "isMember"],
                                    properties: {
                                        userId: { type: "string", nullable: true },
                                        isOwner: { type: "boolean" },
                                        isMember: { type: "boolean" }
                                    }
                                }
                            }
                        }
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

    // SECURITY: a public playlist is readable by anonymous visitors, but its *collaborator list* is not
    // public information - it enumerates real accounts (usernames, display names, avatars) of people who
    // never chose to be listed publicly. Only the owner and the members themselves see the roster; an
    // outside viewer gets the owner (the playlist's public attribution) and nothing else.
    const isInsider = isOwner || isMember;

    const owner = await getUserById(playlist.ownerId, true);
    const members = isInsider
        ? (await Promise.all((await getMembers(playlist.id)).map((m) => getUserById(m.userId, true)))).filter((u) => u !== null)
        : [];

    const pagination = parsePagination(event);
    const [rows, entriesTotal] = await Promise.all([
        getEntries(playlist.id, pagination.limit, pagination.offset),
        countEntries(playlist.id)
    ]);

    // same reasoning as `members` above: who added which track identifies collaborators to outsiders
    const entries = await Promise.all(rows.map(async (entry) => ({
        entryId: entry.entryId,
        addedBy: isInsider ? await getUserById(entry.addedBy, true) : null,
        position: entry.position,
        addedAt: entry.addedAt,
        media: entry.media
    })));

    return {
        playlist,
        owner,
        members,
        entries,
        entriesTotal,
        entriesHasMore: pagination.page * pagination.limit < entriesTotal,
        viewer: { userId, isOwner, isMember }
    };
});
