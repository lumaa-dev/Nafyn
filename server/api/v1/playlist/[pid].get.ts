// playlist detail; public playlists are readable by anonymous visitors, private ones require owner/member access
import { getPlaylistById, getMembers, getEntries, hasAccess } from "~~/server/core/playlists";
import { getUserById } from "~~/server/core/users";
import { verifyAuthToken } from "~~/server/utils/jwt";

defineRouteMeta({
    openAPI: {
        description: "Get playlist details: metadata, owner, members, and entries. Public playlists are readable by anonymous visitors (an Authorization header is optional here); private ones require owner/member access",
        tags: ["playlist"],
        operationId: "getPlaylist",
        parameters: [
            {
                name: "pid",
                in: "path",
                required: true,
                description: "Playlist ID",
                schema: { type: "string" }
            }
        ],
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: {
                            type: "object",
                            required: ["playlist", "owner", "members", "entries", "viewer"],
                            properties: {
                                playlist: { $ref: "#/components/schemas/PlaylistRow" },
                                owner: { $ref: "#/components/schemas/NafynUser" },
                                members: {
                                    type: "array",
                                    items: { $ref: "#/components/schemas/NafynUser" }
                                },
                                entries: {
                                    type: "array",
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

    const owner = await getUserById(playlist.ownerId, true);
    const members = (await Promise.all((await getMembers(playlist.id)).map((m) => getUserById(m.userId, true))))
        .filter((u) => u !== null);

    const entries = await Promise.all((await getEntries(playlist.id)).map(async (entry) => ({
        entryId: entry.entryId,
        addedBy: await getUserById(entry.addedBy, true),
        position: entry.position,
        addedAt: entry.addedAt,
        media: entry.media
    })));

    return {
        playlist,
        owner,
        members,
        entries,
        viewer: { userId, isOwner, isMember }
    };
});
