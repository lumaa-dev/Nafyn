import { getPlaylistById, hasAccess, updatePlaylist } from "~~/server/core/playlists";

const SORT_MODES = ["manual", "title", "artist", "addedBy", "duration"];

defineRouteMeta({
    openAPI: {
        description: "Update a playlist's details (owner-only) and/or sortMode (owner or any invited member). Only the provided fields are changed",
        tags: ["playlist"],
        operationId: "updatePlaylist",
        parameters: [
            {
                name: "pid",
                in: "path",
                required: true,
                description: "Playlist ID",
                schema: { type: "string" }
            }
        ],
        requestBody: {
            content: {
                "application/json": {
                    schema: {
                        type: "object",
                        properties: {
                            title: { type: "string", description: "1-100 characters. Owner only" },
                            description: { type: "string", nullable: true, description: "Owner only" },
                            privacy: { type: "string", enum: ["public", "private"], description: "Owner only" },
                            sortMode: { type: "string", enum: SORT_MODES, description: "Owner or any invited member" }
                        }
                    }
                }
            }
        },
        responses: {
            "200": {
                description: "",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/PlaylistRow" }
                    }
                }
            },
            "400": {
                description: "Missing playlist ID, invalid sortMode, or invalid title length",
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
            "403": {
                description: "Not the owner (for detail edits), or no access to the playlist (for sortMode)",
                content: {
                    "application/json": {
                        schema: { $ref: "#/components/schemas/NuxtError" }
                    }
                }
            },
            "404": {
                description: "Playlist not found",
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
    const { sub: userId } = requireAuthToken(event);

    const pid = getRouterParam(event, "pid");
    if (!pid) {
        throw createError({ statusCode: 400, statusMessage: "Missing playlist ID" });
    }

    const playlist = await getPlaylistById(pid);
    if (!playlist) {
        throw createError({ statusCode: 404, statusMessage: "Playlist not found" });
    }

    const isOwner = playlist.ownerId === userId;
    const body = await readBody(event);
    const patch: Parameters<typeof updatePlaylist>[1] = {};

    // sortMode is a shared view preference: owner or any invited member may change it
    if (typeof body?.sortMode === "string") {
        if (!isOwner && !await hasAccess(playlist, userId)) {
            throw createError({ statusCode: 403, statusMessage: "You don't have access to this playlist" });
        }
        if (!SORT_MODES.includes(body.sortMode)) {
            throw createError({ statusCode: 400, statusMessage: "Invalid sortMode" });
        }
        patch.sortMode = body.sortMode;
    }

    const editsDetails = typeof body?.title === "string" || typeof body?.description === "string" || body?.description === null || body?.privacy === "public" || body?.privacy === "private";
    if (editsDetails && !isOwner) {
        throw createError({ statusCode: 403, statusMessage: "Only the playlist owner can edit its details" });
    }

    if (typeof body?.title === "string") {
        const title = body.title.trim();
        if (title.length < 1 || title.length > 100) {
            throw createError({ statusCode: 400, statusMessage: "Title must be between 1 and 100 characters" });
        }
        patch.title = title;
    }

    if (typeof body?.description === "string" || body?.description === null) {
        patch.description = typeof body.description === "string" ? body.description.trim() || null : null;
    }

    if (body?.privacy === "public" || body?.privacy === "private") {
        patch.privacy = body.privacy;
    }

    return await updatePlaylist(pid, patch);
});
